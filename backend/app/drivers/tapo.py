"""Driver for TP-Link Tapo P110 smart plug (power/energy monitoring).

Credentials come from env (TAPO_EMAIL / TAPO_PASSWORD) or device config.
"""
import os

from tapo import ApiClient


def _creds(config: dict) -> tuple[str, str]:
    email = config.get("email") or os.getenv("TAPO_EMAIL", "")
    password = config.get("password") or os.getenv("TAPO_PASSWORD", "")
    return email, password


async def get_status(ip: str, config: dict) -> dict:
    email, password = _creds(config)
    if not email or not password:
        return {"available": False, "error": "Tapo credentials not configured"}

    client = ApiClient(email, password)
    device = await client.p110(ip)

    info = await device.get_device_info()
    power = await device.get_current_power()
    usage = await device.get_energy_usage()

    today_kwh = getattr(usage, "today_energy", 0) / 1000
    return {
        "available": True,
        "is_on": info.device_on,
        "nickname": getattr(info, "nickname", "P110"),
        "power_w": getattr(power, "current_power", 0),
        "today_kwh": round(today_kwh, 3),
    }


async def set_state(ip: str, config: dict, on: bool) -> dict:
    email, password = _creds(config)
    client = ApiClient(email, password)
    device = await client.p110(ip)
    if on:
        await device.on()
    else:
        await device.off()
    return {"success": True}
