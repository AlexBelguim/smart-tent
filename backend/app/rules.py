"""Automation rules, evaluated after each poll. Ported from the old app's behavior.

Day/night is derived from the grow light: any enabled Wiz plug with role "light"
that is currently on (falling back to its schedule times if the plug is unreachable).

Per-device config:

- Wiz plug, any role — daily schedule:
    config["schedule"] = {"enabled": true, "on": "06:00", "off": "00:00"}
    (on > off means the span crosses midnight)

- Wiz plug, heater — thermostat with hysteresis (old heater rework behavior:
  ON below target - hyst_on, OFF above target + hyst_off, no delay):
    config["hysteresis"] = {
        "enabled": true, "day_temp": 22, "night_temp": 20,
        "hyst_on": 0.5, "hyst_off": 2.0,
        "source_device_id": 1, "sensors": ["28D4..."],   # empty list = all sensors
    }

- ESP32 fan — auto speed control:
    config["auto"] = {
        "enabled": true, "day_speed": 75, "night_speed": 15,
        "humidity_override": true, "hum_on": 10, "hum_off": 5,
    }
    Humidity override (highest priority): fan -> 100% when a Dreo humidity
    reading >= its target + hum_on, released when < target + hum_off.

Commands are only sent when the desired state differs from the current one.
"""
import logging
from datetime import datetime

from .db import Device
from .drivers import wiz, esp32

log = logging.getLogger("rules")

# Latched humidity-override state per fan device (in-memory; resets on restart)
_humidity_override: dict[int, bool] = {}


def _schedule_wants_on(schedule: dict, now: datetime) -> bool | None:
    try:
        on_h, on_m = map(int, str(schedule.get("on", "")).split(":"))
        off_h, off_m = map(int, str(schedule.get("off", "")).split(":"))
    except ValueError:
        return None
    minutes = now.hour * 60 + now.minute
    on_t = on_h * 60 + on_m
    off_t = off_h * 60 + off_m
    if on_t == off_t:
        return None
    if on_t < off_t:
        return on_t <= minutes < off_t
    return minutes >= on_t or minutes < off_t  # spans midnight


def is_day(devices: list[Device], latest: dict, now: datetime) -> bool:
    """Day = a grow light is on. No light plug registered -> treat as day."""
    lights = [d for d in devices if d.kind == "wiz" and d.role == "light" and d.enabled]
    if not lights:
        return True
    for light in lights:
        status = latest.get(light.id, {})
        if status.get("available"):
            if status.get("is_on"):
                return True
            continue
        # plug unreachable: fall back to its schedule if it has one
        want = _schedule_wants_on(light.config.get("schedule") or {}, now)
        if want:
            return True
    return False


def _selected_temps(source_status: dict, selected: list[str]) -> list[float]:
    temps = []
    for s in source_status.get("sensors", []):
        if not (s.get("valid") and s.get("temp_c") is not None):
            continue
        if selected and s.get("address") not in selected and s.get("name") not in selected:
            continue
        temps.append(float(s["temp_c"]))
    return temps


async def _set_plug(device: Device, latest: dict, want_on: bool, reason: str):
    status = latest.get(device.id, {})
    if status.get("available") and status.get("is_on") == want_on:
        return
    try:
        if want_on:
            await wiz.turn_on(device.ip)
        else:
            await wiz.turn_off(device.ip)
        log.info("%s -> %s (%s)", device.name, "ON" if want_on else "OFF", reason)
        if device.id in latest:
            latest[device.id]["is_on"] = want_on
    except Exception as e:
        log.error("failed to switch %s: %s", device.name, e)


async def _apply_heater(device: Device, latest: dict, day: bool):
    hyst = device.config.get("hysteresis") or {}
    if not hyst.get("enabled"):
        return
    source_status = latest.get(hyst.get("source_device_id"), {})
    if not source_status.get("available"):
        return  # no sensor data -> leave plug as-is

    # Back-compat: old configs stored a single "source_label"
    selected = hyst.get("sensors")
    if selected is None:
        selected = [hyst["source_label"]] if hyst.get("source_label") else []

    temps = _selected_temps(source_status, selected)
    if not temps:
        return
    temp = sum(temps) / len(temps)

    target = float(hyst.get("day_temp", 22) if day else hyst.get("night_temp", 20))
    hyst_on = float(hyst.get("hyst_on", 0.5))
    hyst_off = float(hyst.get("hyst_off", 2.0))

    if temp < target - hyst_on:
        await _set_plug(device, latest, True,
                        f"{'day' if day else 'night'} {temp:.1f}C < {target - hyst_on:.1f}C")
    elif temp > target + hyst_off:
        await _set_plug(device, latest, False,
                        f"{'day' if day else 'night'} {temp:.1f}C > {target + hyst_off:.1f}C")


def _humidity_wants_override(fan_id: int, devices: list[Device], latest: dict, auto: dict) -> bool:
    """Latched override: enter at target + hum_on, exit below target + hum_off."""
    active = _humidity_override.get(fan_id, False)
    for d in devices:
        if d.kind != "dreo" or not d.enabled:
            continue
        status = latest.get(d.id, {})
        humidity = status.get("humidity")
        target = status.get("target_humidity")
        if not status.get("available") or humidity is None or target is None:
            continue
        trigger = target + float(auto.get("hum_on", 10))
        release = target + float(auto.get("hum_off", 5))
        if active and humidity < release:
            active = False
            log.info("humidity override OFF: %s%% < %s%%", humidity, release)
        elif not active and humidity >= trigger:
            active = True
            log.info("humidity override ON: %s%% >= %s%%", humidity, trigger)
        break  # first available dreo decides
    _humidity_override[fan_id] = active
    return active


async def _apply_fan(device: Device, devices: list[Device], latest: dict, day: bool):
    auto = device.config.get("auto") or {}
    status = latest.get(device.id, {})
    if not auto.get("enabled"):
        if status:
            status["mode"] = "manual"
        return
    if not status.get("available"):
        return

    if auto.get("humidity_override", True) and _humidity_wants_override(device.id, devices, latest, auto):
        target = 100
        reason = "humidity override"
        status["mode"] = "humidity boost"
    else:
        target = int(auto.get("day_speed", 75) if day else auto.get("night_speed", 15))
        reason = "day mode" if day else "night mode"
        status["mode"] = "day" if day else "night"

    current = status.get("speed")
    if current is not None and current != target:
        try:
            await esp32.set_speed(device.ip, device.config, target)
            log.info("%s: %s%% -> %s%% (%s)", device.name, current, target, reason)
            latest[device.id]["speed"] = target
        except Exception as e:
            log.error("failed to set fan %s: %s", device.name, e)


async def apply(session, devices: list[Device], latest: dict):
    now = datetime.now()
    day = is_day(devices, latest, now)

    for device in devices:
        if not device.enabled:
            continue

        if device.kind == "wiz":
            schedule = device.config.get("schedule") or {}
            if schedule.get("enabled"):
                want = _schedule_wants_on(schedule, now)
                if want is not None:
                    await _set_plug(device, latest, want, "schedule")
                    continue  # schedule wins over hysteresis on the same plug
            await _apply_heater(device, latest, day)

        elif device.kind == "esp32_fan":
            await _apply_fan(device, devices, latest, day)
