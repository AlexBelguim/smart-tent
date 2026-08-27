"""Driver for the ESP32 Smart Tent Controller (fan PWM + DS18B20 temps).

Talks to the existing firmware in esp32_fan_controller.ino — do not change the ESP32 side.
Auth: the firmware stores a SHA-256 hash of the access code; we send sha256(code) as hex.
"""
import hashlib

import httpx

TIMEOUT = httpx.Timeout(6.0)


def _auth_hash(config: dict) -> str:
    code = str(config.get("auth_code", "4444"))
    return hashlib.sha256(code.encode()).hexdigest()


async def get_status(ip: str, config: dict) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"http://{ip}/status")
        r.raise_for_status()
        data = r.json()
    # Names live in the app DB (device config), not on the ESP32: the firmware's
    # NVS keys are capped at 15 chars while sensor addresses are 16, so its own
    # name storage silently never persists.
    names = config.get("sensor_names") or {}
    return {
        "available": True,
        "speed": data.get("speed", 0),
        "enabled": data.get("enabled", True),
        "rssi": data.get("rssi"),
        "sensors": [
            {
                "address": s.get("address"),
                "name": names.get(s.get("address"), s.get("name")),
                "temp_c": s.get("temp_c"),
                "valid": s.get("valid", False),
            }
            for s in data.get("sensors", [])
        ],
        "schedules": data.get("schedules", []),
    }


async def set_speed(ip: str, config: dict, speed: int) -> dict:
    speed = max(0, min(100, int(speed)))
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"http://{ip}/speed",
            json={"auth_hash": _auth_hash(config), "speed": speed},
        )
        r.raise_for_status()
        return r.json()


async def get_schedules(ip: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"http://{ip}/schedules")
        r.raise_for_status()
        return r.json()


async def set_schedules(ip: str, config: dict, schedules: list) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"http://{ip}/schedules",
            json={"auth_hash": _auth_hash(config), "schedules": schedules},
        )
        r.raise_for_status()
        return r.json()


async def detect_sensors(ip: str) -> dict:
    """Ask the ESP32 to re-scan the OneWire bus (picks up added/removed sensors)."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"http://{ip}/detect")
        r.raise_for_status()
        return r.json()


async def rename_sensor(ip: str, address: str, name: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(f"http://{ip}/name", json={"address": address, "name": name})
        r.raise_for_status()
        return r.json()
