"""Database models and session setup (SQLite via SQLAlchemy)."""
import json
import os
from datetime import datetime, date

from sqlalchemy import (
    create_engine, Integer, String, Float, Boolean, Date, DateTime,
    ForeignKey, Index, Text, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

DATA_DIR = os.getenv("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "tent.db")

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Device(Base):
    """A registered device. `role` is user-assigned (light, heater, ...), never hardcoded."""
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # esp32_fan | wiz | tapo | dreo
    name: Mapped[str] = mapped_column(String(64))
    ip: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(32), default="other")  # light|heater|humidifier|exhaust|other
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def config(self) -> dict:
        try:
            return json.loads(self.config_json or "{}")
        except ValueError:
            return {}

    @config.setter
    def config(self, value: dict):
        self.config_json = json.dumps(value or {})

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "ip": self.ip,
            "role": self.role,
            "config": self.config,
            "enabled": self.enabled,
        }


class Reading(Base):
    """A single sampled metric value (temperature, power, humidity, fan speed...)."""
    __tablename__ = "readings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    metric: Mapped[str] = mapped_column(String(24))  # temp_c | power_w | humidity | fan_speed | target_humidity
    label: Mapped[str] = mapped_column(String(64), default="")  # e.g. DS18B20 sensor name/address
    value: Mapped[float] = mapped_column(Float)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_readings_lookup", "device_id", "metric", "ts"),
        Index("ix_readings_ts", "ts"),
    )


class EnergyDaily(Base):
    """One row per device per day of accumulated energy."""
    __tablename__ = "energy_daily"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    day: Mapped[date] = mapped_column(Date)
    kwh: Mapped[float] = mapped_column(Float, default=0.0)

    __table_args__ = (UniqueConstraint("device_id", "day", name="uq_energy_device_day"),)


class Plant(Base):
    __tablename__ = "plants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    variety: Mapped[str] = mapped_column(String(64), default="")
    medium: Mapped[str] = mapped_column(String(64), default="soil")
    planted_at: Mapped[date] = mapped_column(Date, default=date.today)
    notes: Mapped[str] = mapped_column(Text, default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)

    events: Mapped[list["PlantEvent"]] = relationship(
        back_populates="plant", cascade="all, delete-orphan"
    )

    def to_dict(self, with_events: bool = False) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "variety": self.variety,
            "medium": self.medium,
            "planted_at": self.planted_at.isoformat() if self.planted_at else None,
            "notes": self.notes,
            "archived": self.archived,
        }
        if with_events:
            d["events"] = [e.to_dict() for e in sorted(self.events, key=lambda e: e.ts, reverse=True)]
        return d


class PlantEvent(Base):
    """Watering / feeding / notes per plant. `mix` records what water/nutrients were used."""
    __tablename__ = "plant_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    type: Mapped[str] = mapped_column(String(24), default="water")  # water|feed|note|transplant|harvest
    amount_l: Mapped[float | None] = mapped_column(Float, nullable=True)
    mix: Mapped[str] = mapped_column(String(128), default="")  # e.g. "tap water + BioGrow 2ml/L"
    ph: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    plant: Mapped[Plant] = relationship(back_populates="events")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "plant_id": self.plant_id,
            "ts": self.ts.isoformat(),
            "type": self.type,
            "amount_l": self.amount_l,
            "mix": self.mix,
            "ph": self.ph,
            "notes": self.notes,
        }


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


DEFAULT_SETTINGS = {
    "kwh_price": "0.35",
    "currency": "€",
    "poll_interval_s": "60",       # history-write cadence (all devices)
    "display_interval_s": "2",     # fast live-view cadence (local devices only)
    "dreo_interval_s": "300",
}


def get_setting(session, key: str) -> str:
    row = session.get(Setting, key)
    if row is not None:
        return row.value
    return DEFAULT_SETTINGS.get(key, "")


def init_db():
    Base.metadata.create_all(engine)
