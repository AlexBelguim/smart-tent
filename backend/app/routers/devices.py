"""Device registry CRUD, live status, control actions, and Wiz discovery."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..db import SessionLocal, Device
from ..drivers import esp32, wiz, tapo, dreo
from ..security import check_pin, require_pin
from .. import poller

router = APIRouter(prefix="/api")


class AuthIn(BaseModel):
    pin: str


@router.post("/auth")
def auth(body: AuthIn):
    """Verify the settings PIN (used by the Settings page gate)."""
    if not check_pin(body.pin):
        raise HTTPException(401, "Invalid PIN")
    return {"success": True}

KINDS = {"esp32_fan", "wiz", "tapo", "dreo"}
ROLES = {"light", "heater", "humidifier", "exhaust", "energy", "other"}


class DeviceIn(BaseModel):
    kind: str
    name: str
    ip: str = ""
    role: str = "other"
    config: dict = {}
    enabled: bool = True


class DevicePatch(BaseModel):
    name: str | None = None
    ip: str | None = None
    role: str | None = None
    config: dict | None = None
    enabled: bool | None = None


class ActionIn(BaseModel):
    action: str  # on | off | speed
    value: int | None = None


@router.get("/devices")
def list_devices():
    session = SessionLocal()
    try:
        devices = session.query(Device).all()
        return [
            {**d.to_dict(), "status": poller.latest.get(d.id, {"available": False, "error": "not polled yet"})}
            for d in devices
        ]
    finally:
        session.close()


@router.post("/devices", dependencies=[Depends(require_pin)])
def create_device(body: DeviceIn):
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(KINDS)}")
    session = SessionLocal()
    try:
        device = Device(kind=body.kind, name=body.name, ip=body.ip,
                        role=body.role, enabled=body.enabled)
        device.config = body.config
        session.add(device)
        session.commit()
        return device.to_dict()
    finally:
        session.close()


@router.patch("/devices/{device_id}", dependencies=[Depends(require_pin)])
def update_device(device_id: int, body: DevicePatch):
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
        if device is None:
            raise HTTPException(404, "device not found")
        if body.name is not None:
            device.name = body.name
        if body.ip is not None:
            device.ip = body.ip
        if body.role is not None:
            device.role = body.role
        if body.config is not None:
            device.config = body.config
        if body.enabled is not None:
            device.enabled = body.enabled
        session.commit()
        return device.to_dict()
    finally:
        session.close()


@router.delete("/devices/{device_id}", dependencies=[Depends(require_pin)])
def delete_device(device_id: int):
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
        if device is None:
            raise HTTPException(404, "device not found")
        session.delete(device)
        session.commit()
        poller.latest.pop(device_id, None)
        return {"success": True}
    finally:
        session.close()


@router.get("/devices/{device_id}/status")
async def live_status(device_id: int):
    """Bypass the poller cache and query the device right now."""
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
    finally:
        session.close()
    if device is None:
        raise HTTPException(404, "device not found")
    try:
        status = await poller.fetch_status(device)
        poller.latest[device_id] = {**status, "updated": "now"}
        return status
    except Exception as e:
        return {"available": False, "error": str(e)}


@router.post("/devices/{device_id}/detect_sensors", dependencies=[Depends(require_pin)])
async def detect_sensors(device_id: int):
    """Re-scan the OneWire bus on the ESP32 and refresh the cached status."""
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
    finally:
        session.close()
    if device is None:
        raise HTTPException(404, "device not found")
    if device.kind != "esp32_fan":
        raise HTTPException(400, "sensor detection only applies to esp32_fan devices")
    try:
        result = await esp32.detect_sensors(device.ip)
        status = await poller.fetch_status(device)
        status["updated"] = "now"
        poller.latest[device_id] = status
        return {"sensors": result.get("sensors", []), "status": status}
    except Exception as e:
        raise HTTPException(502, f"detect failed: {e}")


class SensorNameIn(BaseModel):
    address: str
    name: str


@router.post("/devices/{device_id}/sensor_name", dependencies=[Depends(require_pin)])
async def rename_sensor(device_id: int, body: SensorNameIn):
    """Rename a DS18B20 sensor. Stored in the app DB - the ESP32's own NVS name
    storage silently drops names (its keys are capped below the address length)."""
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
        if device is None:
            raise HTTPException(404, "device not found")
        if device.kind != "esp32_fan":
            raise HTTPException(400, "sensor renaming only applies to esp32_fan devices")
        config = device.config
        names = config.get("sensor_names") or {}
        names[body.address] = body.name
        config["sensor_names"] = names
        device.config = config
        session.commit()
    finally:
        session.close()
    # refresh the cache so the new name shows up immediately
    try:
        status = await poller.fetch_status(device)
        status["updated"] = "now"
        poller.latest[device_id] = status
    except Exception:
        pass
    return {"success": True}


@router.post("/devices/{device_id}/action")
async def device_action(device_id: int, body: ActionIn):
    session = SessionLocal()
    try:
        device = session.get(Device, device_id)
    finally:
        session.close()
    if device is None:
        raise HTTPException(404, "device not found")

    cfg = device.config
    try:
        if device.kind == "esp32_fan" and body.action == "speed":
            return await esp32.set_speed(device.ip, cfg, body.value or 0)
        if device.kind == "wiz" and body.action in ("on", "off"):
            result = await (wiz.turn_on(device.ip) if body.action == "on" else wiz.turn_off(device.ip))
            if device_id in poller.latest:
                poller.latest[device_id]["is_on"] = body.action == "on"
            return result
        if device.kind == "tapo" and body.action in ("on", "off"):
            return await tapo.set_state(device.ip, cfg, body.action == "on")
    except Exception as e:
        raise HTTPException(502, f"device command failed: {e}")

    raise HTTPException(400, f"action '{body.action}' not supported for kind '{device.kind}'")


@router.get("/discover/wiz")
async def discover_wiz(broadcast: str = "255.255.255.255"):
    session = SessionLocal()
    try:
        known_ips = {d.ip for d in session.query(Device).filter(Device.kind == "wiz").all()}
    finally:
        session.close()
    try:
        found = await asyncio.wait_for(wiz.discover(broadcast), timeout=10)
    except asyncio.TimeoutError:
        found = []
    for f in found:
        f["registered"] = f["ip"] in known_ips
    return found
