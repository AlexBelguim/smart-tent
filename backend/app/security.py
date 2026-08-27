"""PIN gate for settings/config endpoints.

The PIN comes from the TENT_PIN env var (default 4444) and is only ever
compared as a SHA-256 hash, same scheme as the ESP32 firmware. Clients send
the PIN in the X-Pin header; read-only endpoints stay open.
"""
import hashlib
import hmac
import os

from fastapi import Header, HTTPException


def _pin_hash() -> str:
    pin = os.getenv("TENT_PIN", "4444")
    return hashlib.sha256(pin.encode()).hexdigest()


def check_pin(pin: str) -> bool:
    provided = hashlib.sha256((pin or "").encode()).hexdigest()
    return hmac.compare_digest(provided, _pin_hash())


def require_pin(x_pin: str = Header(default="")):
    if not check_pin(x_pin):
        raise HTTPException(401, "PIN required")
