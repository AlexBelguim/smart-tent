"""Driver for Wiz smart plugs/lights (local UDP, port 38899)."""
from pywizlight import wizlight, PilotBuilder
from pywizlight.discovery import discover_lights


async def get_status(ip: str, config: dict) -> dict:
    light = wizlight(ip)
    try:
        state = await light.updateState()
        # some pywizlight versions return a list of PilotParser objects
        if isinstance(state, list):
            state = state[0] if state else None
        if state is None:
            return {"available": False, "error": "no response from plug"}
        is_on = bool(state.get_state())
        try:
            brightness = state.get_brightness() if is_on else 0
        except Exception:
            brightness = 0
        return {
            "available": True,
            "is_on": is_on,
            "brightness": brightness,
        }
    finally:
        try:
            await light.async_close()
        except Exception:
            pass


async def turn_on(ip: str) -> dict:
    light = wizlight(ip)
    try:
        await light.turn_on(PilotBuilder())
        return {"success": True}
    finally:
        try:
            await light.async_close()
        except Exception:
            pass


async def turn_off(ip: str) -> dict:
    light = wizlight(ip)
    try:
        await light.turn_off()
        return {"success": True}
    finally:
        try:
            await light.async_close()
        except Exception:
            pass


async def discover(broadcast: str = "255.255.255.255") -> list[dict]:
    """Discover Wiz devices on the LAN via UDP broadcast."""
    found = await discover_lights(broadcast_space=broadcast)
    results = []
    for b in found:
        results.append({"ip": b.ip, "mac": getattr(b, "mac", None)})
    return results
