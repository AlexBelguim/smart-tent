"""Tent App — FastAPI entrypoint. Serves the API and the built React frontend."""
import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from .db import init_db  # noqa: E402
from . import poller  # noqa: E402
from .routers import devices, history, planner, settings  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    task = asyncio.create_task(poller.run_forever())
    yield
    task.cancel()


app = FastAPI(title="Tent App", lifespan=lifespan)

app.include_router(devices.router)
app.include_router(history.router)
app.include_router(planner.router)
app.include_router(settings.router)


@app.get("/api/health")
def health():
    return {"ok": True}


# Serve the built frontend (frontend/dist) if present
FRONTEND_DIST = os.getenv(
    "FRONTEND_DIST",
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"),
)
if os.path.isdir(FRONTEND_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")

    # index.html must never be cached: it points at hashed asset filenames that
    # change on every rebuild, and a stale copy leaves the browser on the old UI.
    NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = os.path.join(FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(FRONTEND_DIST, "index.html"), headers=NO_CACHE)
