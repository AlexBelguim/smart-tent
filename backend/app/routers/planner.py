"""Grow planner: plants and their watering/feeding/note events."""
from datetime import date, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import SessionLocal, Plant, PlantEvent

router = APIRouter(prefix="/api")

EVENT_TYPES = {"water", "feed", "note", "transplant", "harvest"}


class PlantIn(BaseModel):
    name: str
    variety: str = ""
    medium: str = "soil"
    planted_at: date | None = None
    notes: str = ""


class PlantPatch(BaseModel):
    name: str | None = None
    variety: str | None = None
    medium: str | None = None
    planted_at: date | None = None
    notes: str | None = None
    archived: bool | None = None


class EventIn(BaseModel):
    type: str = "water"
    ts: datetime | None = None
    amount_l: float | None = None
    mix: str = ""
    ph: float | None = None
    notes: str = ""
    plant_ids: list[int] | None = None  # extra plants to log the same event on


@router.get("/plants")
def list_plants(include_archived: bool = False):
    session = SessionLocal()
    try:
        q = session.query(Plant)
        if not include_archived:
            q = q.filter(Plant.archived == False)  # noqa: E712
        return [p.to_dict(with_events=True) for p in q.order_by(Plant.planted_at.desc()).all()]
    finally:
        session.close()


@router.post("/plants")
def create_plant(body: PlantIn):
    session = SessionLocal()
    try:
        plant = Plant(
            name=body.name, variety=body.variety, medium=body.medium,
            planted_at=body.planted_at or date.today(), notes=body.notes,
        )
        session.add(plant)
        session.commit()
        return plant.to_dict()
    finally:
        session.close()


@router.patch("/plants/{plant_id}")
def update_plant(plant_id: int, body: PlantPatch):
    session = SessionLocal()
    try:
        plant = session.get(Plant, plant_id)
        if plant is None:
            raise HTTPException(404, "plant not found")
        for field in ("name", "variety", "medium", "planted_at", "notes", "archived"):
            value = getattr(body, field)
            if value is not None:
                setattr(plant, field, value)
        session.commit()
        return plant.to_dict()
    finally:
        session.close()


@router.delete("/plants/{plant_id}")
def delete_plant(plant_id: int):
    session = SessionLocal()
    try:
        plant = session.get(Plant, plant_id)
        if plant is None:
            raise HTTPException(404, "plant not found")
        session.delete(plant)
        session.commit()
        return {"success": True}
    finally:
        session.close()


@router.post("/plants/{plant_id}/events")
def add_event(plant_id: int, body: EventIn):
    if body.type not in EVENT_TYPES:
        raise HTTPException(400, f"type must be one of {sorted(EVENT_TYPES)}")
    session = SessionLocal()
    try:
        target_ids = {plant_id, *(body.plant_ids or [])}
        created = []
        for pid in target_ids:
            if session.get(Plant, pid) is None:
                raise HTTPException(404, f"plant {pid} not found")
            event = PlantEvent(
                plant_id=pid, type=body.type, ts=body.ts or datetime.utcnow(),
                amount_l=body.amount_l, mix=body.mix, ph=body.ph, notes=body.notes,
            )
            session.add(event)
            created.append(event)
        session.commit()
        return [e.to_dict() for e in created]
    finally:
        session.close()


@router.delete("/events/{event_id}")
def delete_event(event_id: int):
    session = SessionLocal()
    try:
        event = session.get(PlantEvent, event_id)
        if event is None:
            raise HTTPException(404, "event not found")
        session.delete(event)
        session.commit()
        return {"success": True}
    finally:
        session.close()
