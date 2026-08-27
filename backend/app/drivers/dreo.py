"""Driver for Dreo humidifier via Dreo cloud (pydreo-cloud, EU region).

The library is synchronous, so calls are wrapped with asyncio.to_thread by the poller.
Credentials come from env (DREO_EMAIL / DREO_PASSWORD) or device config.
EU quirk: the API expects the password MD5-hashed.
"""
import hashlib
import os

try:
    from pydreo.client import DreoClient
    import pydreo.helpers

    _EU_URL = "https://open-api-eu.dreo-tech.com"
    pydreo.helpers.BASE_URL = _EU_URL
    pydreo.helpers.US_BASE_URL = _EU_URL
    DREO_AVAILABLE = True
except ImportError:
    DREO_AVAILABLE = False


def _creds(config: dict) -> tuple[str, str]:
    email = config.get("email") or os.getenv("DREO_EMAIL", "")
    password = config.get("password") or os.getenv("DREO_PASSWORD", "")
    return email, password


def get_status_sync(config: dict) -> dict:
    if not DREO_AVAILABLE:
        return {"available": False, "error": "pydreo-cloud not installed"}

    email, password = _creds(config)
    if not email or not password:
        return {"available": False, "error": "Dreo credentials not configured"}

    client = DreoClient(email, hashlib.md5(password.encode()).hexdigest())
    client.login()
    devices = client.get_devices()
    if not devices:
        return {"available": False, "error": "No devices in Dreo account"}

    device = None
    for d in devices:
        if isinstance(d, dict) and (
            d.get("deviceType") == "humidifier" or d.get("deviceName") == "Humidifier"
        ):
            device = d
            break
    if device is None:
        device = devices[0]

    state = device.get("state", {}) if isinstance(device, dict) else {}
    is_on = state.get("power_switch", False)
    mode = state.get("mode")
    current_humidity = state.get("humidity_sensor")

    target_humidity = state.get("rh_auto")
    if mode == "Sleep":
        target_humidity = state.get("rh_sleep")
    elif mode == "Manual":
        target_humidity = None

    # Infer "actively misting" when the API gives no explicit flag
    is_working = state.get("working", state.get("misting"))
    if is_working is None and is_on:
        if mode == "Manual":
            is_working = True
        elif target_humidity is not None and current_humidity is not None:
            is_working = current_humidity < target_humidity
        else:
            is_working = is_on
    elif is_working is None:
        is_working = False

    return {
        "available": True,
        "is_on": is_on,
        "is_working": bool(is_working),
        "humidity": current_humidity,
        "target_humidity": target_humidity,
        "mode": mode,
    }
