from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.inventory_reconciliation import (
    RECONCILIATION_SUBMIT_PATH,
    reconciliation_request_validation_detail,
)
from app.api.router import api_router
from app.api.shopping_intake import (
    SHOPPING_INTAKE_SUBMIT_PATH,
    shopping_intake_request_validation_detail,
)
from app.ai.images.jobs import ImageGenerationWorker
from app.core.config import LOCAL_ENVIRONMENTS, Settings, get_settings
from app.core.logging import configure_logging
from app.db.session import SessionLocal
from app.services.search.jobs import SearchIndexWorker
from app.services.bootstrap import initialize_configured_admin

configure_logging()
settings = get_settings()
logger = logging.getLogger(__name__)


def local_dev_origin_regex(current_settings: Settings) -> str | None:
    if current_settings.environment.strip().lower() not in LOCAL_ENVIRONMENTS:
        return None
    return r"^http://(localhost|127\.0\.0\.1):\d+$"


def cors_allowed_origins(current_settings: Settings) -> list[str]:
    origins = [current_settings.frontend_origin]
    if current_settings.environment.strip().lower() in LOCAL_ENVIRONMENTS:
        origins.append("http://127.0.0.1:5173")
    return list(dict.fromkeys(origins))


class UnhandledApiExceptionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        response_started = False

        async def tracked_send(message) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked_send)
        except Exception as exc:
            if scope["type"] != "http":
                raise
            request = Request(scope)
            logger.exception(
                "Unhandled API exception method=%s path=%s client=%s",
                request.method,
                request.url.path,
                request.client.host if request.client else None,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            if response_started:
                raise
            response = JSONResponse(status_code=500, content={"detail": "Internal Server Error"})
            await response(scope, receive, tracked_send)
            raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    with SessionLocal() as db:
        initialize_configured_admin(db)
    image_worker = ImageGenerationWorker()
    search_index_worker = SearchIndexWorker()
    image_worker.start()
    search_index_worker.start()
    logger.info("AI image generation worker started")
    logger.info("Search index worker started")
    yield
    search_index_worker.stop()
    image_worker.stop()
    logger.info("Search index worker stopped")
    logger.info("AI image generation worker stopped")


app = FastAPI(title="Culina API", version="0.1.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(request: Request, exc: RequestValidationError):
    if request.method == "POST" and request.url.path == RECONCILIATION_SUBMIT_PATH:
        return JSONResponse(
            status_code=422,
            content={"detail": reconciliation_request_validation_detail(exc.errors())},
        )
    if request.method == "POST" and request.url.path == SHOPPING_INTAKE_SUBMIT_PATH:
        return JSONResponse(
            status_code=422,
            content={"detail": shopping_intake_request_validation_detail(exc.errors())},
        )
    return await request_validation_exception_handler(request, exc)

app.add_middleware(UnhandledApiExceptionMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allowed_origins(settings),
    allow_origin_regex=local_dev_origin_regex(settings),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router)

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
