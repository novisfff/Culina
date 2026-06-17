from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.ai.images.jobs import ImageGenerationWorker
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import SessionLocal
from app.services.bootstrap import initialize_configured_admin

configure_logging()
settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    with SessionLocal() as db:
        initialize_configured_admin(db)
    image_worker = ImageGenerationWorker()
    image_worker.start()
    logger.info("AI image generation worker started")
    yield
    image_worker.stop()
    logger.info("AI image generation worker stopped")


app = FastAPI(title="Culina API", version="0.1.0", lifespan=lifespan)


@app.exception_handler(Exception)
async def log_unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(
        "Unhandled API exception method=%s path=%s client=%s",
        request.method,
        request.url.path,
        request.client.host if request.client else None,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


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
