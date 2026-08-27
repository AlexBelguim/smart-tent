"""History endpoints for graphs: readings time series + daily energy."""
from datetime import date, datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import func

from ..db import SessionLocal, Reading, EnergyDaily, Device, get_setting

router = APIRouter(prefix="/api")


@router.get("/history")
def get_history(metric: str, device_id: int | None = None, hours: int = 24, max_points: int = 500):
    """Time series for one metric, optionally one device, grouped by label.

    Returns {"series": [{"device_id", "label", "points": [[iso_ts, value], ...]}]}
    Downsamples by bucketing when the raw row count exceeds max_points per series.
    """
    since = datetime.utcnow() - timedelta(hours=hours)
    session = SessionLocal()
    try:
        q = session.query(Reading).filter(Reading.metric == metric, Reading.ts >= since)
        if device_id is not None:
            q = q.filter(Reading.device_id == device_id)
        rows = q.order_by(Reading.ts).all()
    finally:
        session.close()

    series: dict[tuple, list] = {}
    for r in rows:
        series.setdefault((r.device_id, r.label), []).append((r.ts, r.value))

    # Map sensor addresses to their current display names (renames don't split series)
    name_maps: dict[int, dict] = {}
    if series:
        session = SessionLocal()
        try:
            for dev in session.query(Device).all():
                names = dev.config.get("sensor_names") or {}
                if names:
                    name_maps[dev.id] = names
        finally:
            session.close()

    result = []
    for (dev_id, label), points in series.items():
        label = name_maps.get(dev_id, {}).get(label, label)
        if len(points) > max_points:
            # average into max_points evenly sized buckets
            bucket_size = len(points) / max_points
            sampled = []
            i = 0.0
            while int(i) < len(points):
                chunk = points[int(i):int(i + bucket_size)] or [points[int(i)]]
                avg = sum(v for _, v in chunk) / len(chunk)
                sampled.append((chunk[len(chunk) // 2][0], round(avg, 2)))
                i += bucket_size
            points = sampled
        result.append({
            "device_id": dev_id,
            "label": label,
            "points": [[ts.isoformat() + "Z", v] for ts, v in points],
        })
    return {"series": result}


@router.get("/energy/daily")
def energy_daily(days: int = 30, device_id: int | None = None):
    since = date.today() - timedelta(days=days - 1)
    session = SessionLocal()
    try:
        kwh_price = float(get_setting(session, "kwh_price") or 0)
        currency = get_setting(session, "currency") or "€"
        q = (
            session.query(EnergyDaily.day, func.sum(EnergyDaily.kwh))
            .filter(EnergyDaily.day >= since)
        )
        if device_id is not None:
            q = q.filter(EnergyDaily.device_id == device_id)
        rows = q.group_by(EnergyDaily.day).order_by(EnergyDaily.day).all()

        # Totals over all recorded history
        total_q = session.query(func.sum(EnergyDaily.kwh))
        month_prefix = date.today().strftime("%Y-%m")
        month_kwh = 0.0
        all_rows = session.query(EnergyDaily.day, func.sum(EnergyDaily.kwh)).group_by(EnergyDaily.day).all()
        for day, kwh in all_rows:
            if day.isoformat().startswith(month_prefix):
                month_kwh += kwh or 0
        total_kwh = total_q.scalar() or 0.0
    finally:
        session.close()

    return {
        "days": [
            {"date": day.isoformat(), "kwh": round(kwh or 0, 3), "cost": round((kwh or 0) * kwh_price, 2)}
            for day, kwh in rows
        ],
        "month_kwh": round(month_kwh, 3),
        "month_cost": round(month_kwh * kwh_price, 2),
        "total_kwh": round(total_kwh, 3),
        "total_cost": round(total_kwh * kwh_price, 2),
        "kwh_price": kwh_price,
        "currency": currency,
    }
