"""Background poller: samples all enabled devices, stores history, applies rules.

Cached latest statuses live in `latest` (device_id -> status dict) so the dashboard
can render instantly without hitting every device on page load.
"""
import asyncio
import logging
import traceback
from datetime import date, datetime

from .db import SessionLocal, Device, Reading, EnergyDaily, get_setting
from .drivers import esp32, wiz, tapo, dreo
from . import rules

log = logging.getLogger("poller")

latest: dict[int, dict] = {}  # device_id -> last known status (+ "updated" iso timestamp)
_dreo_last_poll: dict[int, float] = {}


async def fetch_status(device: Device) -> dict:
    cfg = device.config
    if device.kind == "esp32_fan":
        return await esp32.get_status(device.ip, cfg)
    if device.kind == "wiz":
        return await wiz.get_status(device.ip, cfg)
    if device.kind == "tapo":
        return await tapo.get_status(device.ip, cfg)
    if device.kind == "dreo":
        return await asyncio.to_thread(dreo.get_status_sync, cfg)
    return {"available": False, "error": f"unknown kind {device.kind}"}


def _store_readings(session, device: Device, status: dict):
    now = datetime.utcnow()
    rows = []

    if device.kind == "esp32_fan":
        rows.append(Reading(device_id=device.id, metric="fan_speed", value=status.get("speed", 0), ts=now))
        for s in status.get("sensors", []):
            if s.get("valid") and s.get("temp_c") is not None:
                # keyed by address (stable across renames); mapped to the
                # current display name by the history endpoint
                rows.append(Reading(
                    device_id=device.id, metric="temp_c",
                    label=s.get("address") or s.get("name") or "",
                    value=float(s["temp_c"]), ts=now,
                ))
    elif device.kind == "tapo":
        if status.get("power_w") is not None:
            rows.append(Reading(device_id=device.id, metric="power_w", value=float(status["power_w"]), ts=now))
        today_kwh = status.get("today_kwh")
        if today_kwh is not None:
            _record_energy(session, device.id, today_kwh)
    elif device.kind == "dreo":
        if status.get("humidity") is not None:
            rows.append(Reading(device_id=device.id, metric="humidity", value=float(status["humidity"]), ts=now))
    elif device.kind == "wiz":
        rows.append(Reading(device_id=device.id, metric="is_on", value=1.0 if status.get("is_on") else 0.0, ts=now))

    session.add_all(rows)


def _record_energy(session, device_id: int, today_kwh: float):
    """Upsert today's kWh; never let it drop (midnight rollover protection)."""
    today = date.today()
    row = (
        session.query(EnergyDaily)
        .filter(EnergyDaily.device_id == device_id, EnergyDaily.day == today)
        .one_or_none()
    )
    if row is None:
        session.add(EnergyDaily(device_id=device_id, day=today, kwh=round(today_kwh, 3)))
    elif today_kwh >= row.kwh:
        row.kwh = round(today_kwh, 3)


async def poll_once(store: bool = True):
    """One polling pass.

    store=False is the fast display cycle: only cheap local devices (ESP32, Wiz)
    are polled to refresh the live cache, and nothing is written to history.
    store=True is the full cycle: all devices, readings written to the DB.
    """
    session = SessionLocal()
    try:
        devices = session.query(Device).filter(Device.enabled == True).all()  # noqa: E712
        dreo_interval = float(get_setting(session, "dreo_interval_s") or 300)

        for device in devices:
            # Tapo does a full auth handshake per poll — too heavy for the fast cycle
            if device.kind == "tapo" and not store:
                continue
            # Dreo hits a cloud API — poll it on its own, slower cadence
            if device.kind == "dreo":
                now = asyncio.get_event_loop().time()
                last = _dreo_last_poll.get(device.id, 0)
                if now - last < dreo_interval:
                    continue
                _dreo_last_poll[device.id] = now

            try:
                status = await fetch_status(device)
            except Exception as e:
                status = {"available": False, "error": str(e)}

            status["updated"] = datetime.now().isoformat(timespec="seconds")
            latest[device.id] = status

            if store and status.get("available"):
                try:
                    _store_readings(session, device, status)
                except Exception:
                    log.error("store failed for %s:\n%s", device.name, traceback.format_exc())

        session.commit()

        # Apply automation rules (light schedules, heater hysteresis, fan auto)
        try:
            await rules.apply(session, devices, latest)
        except Exception:
            log.error("rules failed:\n%s", traceback.format_exc())
    finally:
        session.close()


async def run_forever():
    loop = asyncio.get_event_loop()
    last_store = 0.0
    while True:
        session = SessionLocal()
        try:
            store_interval = max(10, float(get_setting(session, "poll_interval_s") or 60))
            display_interval = max(1, float(get_setting(session, "display_interval_s") or 2))
        finally:
            session.close()

        now = loop.time()
        store = now - last_store >= store_interval
        try:
            await poll_once(store=store)
            if store:
                last_store = now
        except Exception:
            log.error("poll_once crashed:\n%s", traceback.format_exc())

        await asyncio.sleep(display_interval)
