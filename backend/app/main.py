from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.inventory_reconciliation import (
    RECONCILIATION_SUBMIT_PATH,
    reconciliation_request_validation_detail,
)
from app.api.family_model_settings import (
    FAMILY_MODEL_SETTINGS_API_PREFIX,
    family_model_settings_request_validation_detail,
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
from app.services.model_usage.maintenance import ModelUsageMaintenanceWorker
from app.services.model_usage.preflight import run_model_usage_preflight
from app.services.media import ensure_media_bucket
from app.services.family_model_settings.maintenance import (
    FamilyModelSettingsMaintenanceWorker,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    validate_credential_keyring_references,
)
from app.services.family_model_settings.errors import (
    FamilyModelCredentialConfigurationError,
)
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


def validate_family_model_credential_keyring_references(
    db,
    *,
    current_settings: Settings,
) -> None:
    """Fail startup before workers/API traffic can use an incomplete keyring.

    Local development bootstraps a persistent keyring only when the database
    has no retained references. Existing references always require their
    original key material. Non-local environments require deployment-managed
    keyring configuration.
    """

    environment = str(getattr(current_settings, "environment", "local")).strip().lower()
    active_key_id = str(getattr(current_settings, "family_model_credential_active_key_id", ""))
    keys_json = getattr(current_settings, "family_model_credential_keys_json", None)
    raw_keys_json = keys_json.get_secret_value() if hasattr(keys_json, "get_secret_value") else str(keys_json or "")
    if environment in LOCAL_ENVIRONMENTS and not active_key_id and not raw_keys_json.strip():
        try:
            cipher = FamilyModelCredentialCipher.from_settings(current_settings)
        except FamilyModelCredentialConfigurationError as exc:
            if exc.code != "family_model_credential_keyring_file_missing":
                raise
            validate_credential_keyring_references(db, keyring=None)
            cipher = FamilyModelCredentialCipher.from_settings(
                current_settings,
                allow_local_keyring_creation=True,
            )
        validate_credential_keyring_references(db, keyring=cipher.keyring)
        return
    cipher = FamilyModelCredentialCipher.from_settings(current_settings)
    validate_credential_keyring_references(db, keyring=cipher.keyring)


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
        with db.begin():
            initialize_configured_admin(db, commit=False)
            if settings.model_usage_required:
                run_model_usage_preflight(settings, session_factory=SessionLocal, db=db)
            validate_family_model_credential_keyring_references(
                db,
                current_settings=settings,
            )
    ensure_media_bucket()
    image_worker = ImageGenerationWorker()
    search_index_worker = SearchIndexWorker()
    model_usage_worker = ModelUsageMaintenanceWorker()
    family_model_settings_worker = FamilyModelSettingsMaintenanceWorker()
    image_worker.start()
    search_index_worker.start()
    if settings.model_usage_maintenance_enabled:
        model_usage_worker.start()
    if settings.family_model_maintenance_enabled:
        family_model_settings_worker.start()
    logger.info("AI image generation worker started")
    logger.info("Search index worker started")
    if settings.model_usage_maintenance_enabled:
        logger.info("Model usage maintenance worker started")
    if settings.family_model_maintenance_enabled:
        logger.info("Family model settings maintenance worker started")
    yield
    if settings.family_model_maintenance_enabled:
        family_model_settings_worker.stop()
        logger.info("Family model settings maintenance worker stopped")
    if settings.model_usage_maintenance_enabled:
        model_usage_worker.stop()
        logger.info("Model usage maintenance worker stopped")
    search_index_worker.stop()
    image_worker.stop()
    logger.info("Search index worker stopped")
    logger.info("AI image generation worker stopped")


app = FastAPI(title="Culina API", version="0.1.0", lifespan=lifespan)


@app.exception_handler(FamilyModelCredentialConfigurationError)
async def handle_family_model_credential_configuration_error(
    request: Request,
    exc: FamilyModelCredentialConfigurationError,
):
    logger.error(
        "Family model credential configuration unavailable path=%s code=%s",
        request.url.path,
        exc.code,
    )
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "detail": {"code": "family_model_credential_configuration_invalid"}
        },
    )


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(request: Request, exc: RequestValidationError):
    if request.url.path.startswith(FAMILY_MODEL_SETTINGS_API_PREFIX):
        return JSONResponse(
            status_code=422,
            content={"detail": family_model_settings_request_validation_detail(exc.errors())},
        )
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
