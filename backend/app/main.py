from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.bootstrap import initialize_configured_admin

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    with SessionLocal() as db:
        initialize_configured_admin(db)
    yield


app = FastAPI(title="Culina API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router)

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
