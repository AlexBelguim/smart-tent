"""App settings (key-value): energy price, currency, poll intervals."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..db import SessionLocal, Setting, DEFAULT_SETTINGS
from ..security import require_pin

router = APIRouter(prefix="/api")

ALLOWED_KEYS = set(DEFAULT_SETTINGS)


class SettingsIn(BaseModel):
    values: dict[str, str]


@router.get("/settings")
def get_settings():
    session = SessionLocal()
    try:
        stored = {s.key: s.value for s in session.query(Setting).all()}
    finally:
        session.close()
    return {**DEFAULT_SETTINGS, **stored}


@router.put("/settings", dependencies=[Depends(require_pin)])
def put_settings(body: SettingsIn):
    session = SessionLocal()
    try:
        for key, value in body.values.items():
            if key not in ALLOWED_KEYS:
                continue
            row = session.get(Setting, key)
            if row is None:
                session.add(Setting(key=key, value=str(value)))
            else:
                row.value = str(value)
        session.commit()
        stored = {s.key: s.value for s in session.query(Setting).all()}
    finally:
        session.close()
    return {**DEFAULT_SETTINGS, **stored}
