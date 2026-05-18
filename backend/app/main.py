from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.core.config import get_settings
from app.core.utils import ensure_directory

settings = get_settings()
ensure_directory(settings.resolved_media_root)

app = FastAPI(title="Culina API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=settings.resolved_media_root), name="media")
app.include_router(api_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
