from __future__ import annotations

from functools import lru_cache
import re
from urllib.parse import quote_plus

from pydantic import SecretStr, computed_field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

LOCAL_ENVIRONMENTS = {"local", "development", "dev", "test", "testing"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = "local"
    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_database: str = "culina"
    mysql_user: str = "culina"
    mysql_password: str = ""
    jwt_secret: str = ""
    access_token_expire_minutes: int = 60 * 24 * 7
    media_max_upload_bytes: int = 30 * 1024 * 1024
    media_access_url_ttl_seconds: int = 300
    realtime_websocket_ticket_ttl_seconds: int = 45
    minio_endpoint: str = "127.0.0.1:9000"
    minio_access_key: str = "culina"
    minio_secret_key: str = "culina_local_minio_secret"
    minio_bucket: str = "culina-media"
    minio_secure: bool = False
    ai_trace_enabled: bool = True
    ai_trace_capture_llm_exchanges: bool = False
    ai_trace_capture_message_content: bool = False
    ai_trace_capture_stream_chunks: bool = False
    ai_trace_capture_image_bytes: bool = False
    ai_trace_payload_mode: str = "redacted"
    ai_trace_retention_days: int = 7
    ai_trace_max_request_bytes: int = 1024 * 1024
    ai_trace_max_response_bytes: int = 1024 * 1024
    model_usage_required: bool = False
    model_usage_maintenance_enabled: bool = True
    model_usage_default_hard_limit: bool = False
    model_usage_receipt_queue_size: int = 1000
    model_usage_receipt_integrity_active_key_id: str = ""
    model_usage_receipt_integrity_keys_json: SecretStr = SecretStr("")
    model_usage_fail_open_proof_ttl_seconds: int = 5
    model_usage_source_instance: str = "culina-api"
    family_model_credential_active_key_id: str = ""
    family_model_credential_keys_json: SecretStr = SecretStr("")
    family_model_credential_keyring_file: str = (
        "storage/secrets/family-model-credential-keyring.json"
    )
    family_model_revoked_secret_retention_hours: int = 24
    family_model_retired_collection_retention_days: int = 7
    family_model_maintenance_enabled: bool = True
    family_model_private_target_allowlist_json: SecretStr = SecretStr(
        '{"http":[],"websocket":[]}'
    )
    family_model_allow_insecure_public_transports: bool = False
    family_model_egress_proxy_url: str = ""
    family_model_provider_connect_timeout_seconds: float = 10.0
    family_model_provider_request_timeout_seconds: float = 180.0
    family_model_provider_response_max_bytes: int = 8 * 1024 * 1024
    family_model_provider_media_max_bytes: int = 30 * 1024 * 1024
    family_model_provider_redirect_limit: int = 0
    # Qdrant itself remains deployment infrastructure, but each immutable
    # family search profile receives an opaque collection name under this
    # deployment-owned prefix. Provider/model identity never appears here.
    family_model_qdrant_collection_prefix: str = "culina_fsp"
    # Platform safety limits for family-owned audio capabilities.  These are
    # deployment limits, not provider/model/key configuration and therefore
    # remain safe to read before resolving a family binding.
    family_model_audio_upload_max_bytes: int = 10 * 1024 * 1024
    family_model_stt_max_duration_seconds: int = 60
    family_model_tts_max_characters: int = 4096
    family_model_realtime_session_max_seconds: int = 300
    search_hybrid_enabled: bool = True
    search_keyword_backend: str = "mysql"
    search_vector_backend: str = "qdrant"
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    qdrant_timeout_seconds: float = 10.0
    frontend_origin: str = "http://localhost:5173"
    log_level: str = "INFO"
    initial_admin_username: str = ""
    initial_admin_password: str = ""
    initial_admin_display_name: str = ""
    initial_admin_email: str = ""
    initial_admin_phone: str = ""
    initial_family_name: str = ""
    initial_family_motto: str = ""
    initial_family_location: str = ""

    @field_validator("family_model_qdrant_collection_prefix", mode="before")
    @classmethod
    def normalize_family_model_qdrant_collection_prefix(cls, value: object) -> str:
        prefix = str(value or "").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", prefix):
            raise ValueError("FAMILY_MODEL_QDRANT_COLLECTION_PREFIX must be a lowercase Qdrant-safe identifier")
        return prefix

    @model_validator(mode="after")
    def validate_safe_runtime_settings(self) -> "Settings":
        provider_timeouts = (
            self.family_model_provider_connect_timeout_seconds,
            self.family_model_provider_request_timeout_seconds,
            self.qdrant_timeout_seconds,
        )
        positive_provider_timeouts = tuple(
            timeout for timeout in provider_timeouts if timeout > 0
        )
        if not positive_provider_timeouts:
            raise ValueError("MODEL_USAGE provider timeouts must be positive")
        minimum_provider_timeout = min(positive_provider_timeouts)
        if (
            self.model_usage_fail_open_proof_ttl_seconds <= 0
            or self.model_usage_fail_open_proof_ttl_seconds >= minimum_provider_timeout
        ):
            raise ValueError(
                "MODEL_USAGE_FAIL_OPEN_PROOF_TTL_SECONDS must be positive and below "
                "the minimum configured provider timeout"
            )
        if self.model_usage_receipt_queue_size <= 0:
            raise ValueError("MODEL_USAGE_RECEIPT_QUEUE_SIZE must be positive")
        if not self.model_usage_source_instance.strip():
            raise ValueError("MODEL_USAGE_SOURCE_INSTANCE is required")
        if self.family_model_revoked_secret_retention_hours <= 0:
            raise ValueError("FAMILY_MODEL_REVOKED_SECRET_RETENTION_HOURS must be positive")
        if self.family_model_retired_collection_retention_days <= 0:
            raise ValueError("FAMILY_MODEL_RETIRED_COLLECTION_RETENTION_DAYS must be positive")
        if self.family_model_provider_connect_timeout_seconds <= 0:
            raise ValueError("FAMILY_MODEL_PROVIDER_CONNECT_TIMEOUT_SECONDS must be positive")
        if self.family_model_provider_request_timeout_seconds <= 0:
            raise ValueError("FAMILY_MODEL_PROVIDER_REQUEST_TIMEOUT_SECONDS must be positive")
        if self.family_model_provider_response_max_bytes <= 0:
            raise ValueError("FAMILY_MODEL_PROVIDER_RESPONSE_MAX_BYTES must be positive")
        if self.family_model_provider_media_max_bytes <= 0:
            raise ValueError("FAMILY_MODEL_PROVIDER_MEDIA_MAX_BYTES must be positive")
        if self.family_model_provider_redirect_limit != 0:
            raise ValueError("FAMILY_MODEL_PROVIDER_REDIRECT_LIMIT must be 0")
        if self.family_model_audio_upload_max_bytes <= 0:
            raise ValueError("FAMILY_MODEL_AUDIO_UPLOAD_MAX_BYTES must be positive")
        if self.family_model_stt_max_duration_seconds <= 0:
            raise ValueError("FAMILY_MODEL_STT_MAX_DURATION_SECONDS must be positive")
        if self.family_model_tts_max_characters <= 0:
            raise ValueError("FAMILY_MODEL_TTS_MAX_CHARACTERS must be positive")
        if self.family_model_realtime_session_max_seconds <= 0:
            raise ValueError("FAMILY_MODEL_REALTIME_SESSION_MAX_SECONDS must be positive")
        if not 30 <= self.media_access_url_ttl_seconds <= 900:
            raise ValueError("MEDIA_ACCESS_URL_TTL_SECONDS must be between 30 and 900")
        if not 30 <= self.realtime_websocket_ticket_ttl_seconds <= 60:
            raise ValueError(
                "REALTIME_WEBSOCKET_TICKET_TTL_SECONDS must be between 30 and 60"
            )

        search_vector_backend = self.search_vector_backend.strip().lower()
        if self.search_keyword_backend.strip().lower() != "mysql":
            raise ValueError("SEARCH_KEYWORD_BACKEND must be mysql")
        if search_vector_backend not in {"qdrant", "disabled"}:
            raise ValueError("SEARCH_VECTOR_BACKEND must be qdrant or disabled")
        if (
            self.search_hybrid_enabled
            and search_vector_backend == "qdrant"
            and not self.qdrant_url.strip()
        ):
            raise ValueError("QDRANT_URL is required when SEARCH_VECTOR_BACKEND=qdrant")
        if self.qdrant_timeout_seconds <= 0:
            raise ValueError("QDRANT_TIMEOUT_SECONDS must be positive")

        environment = self.environment.strip().lower()
        if self.ai_trace_payload_mode.strip().lower() == "full" and environment not in LOCAL_ENVIRONMENTS:
            raise ValueError("Unsafe production settings: AI_TRACE_PAYLOAD_MODE=full is only allowed locally")
        if environment in LOCAL_ENVIRONMENTS:
            return self

        missing: list[str] = []
        if not self.model_usage_required:
            missing.append("MODEL_USAGE_REQUIRED=true")
        if not self.mysql_password:
            missing.append("MYSQL_PASSWORD")
        if not self.jwt_secret:
            missing.append("JWT_SECRET")
        if self.jwt_secret in {"change-me", "culina-local-dev-secret"}:
            missing.append("JWT_SECRET")
        if not self.minio_secret_key or self.minio_secret_key == "culina_local_minio_secret":
            missing.append("MINIO_SECRET_KEY")
        try:
            from app.services.family_model_settings.credentials import (
                decode_family_model_credential_keyring,
            )

            decode_family_model_credential_keyring(
                active_key_id=self.family_model_credential_active_key_id,
                keys_json=self.family_model_credential_keys_json,
            )
        except Exception:
            missing.append(
                "FAMILY_MODEL_CREDENTIAL_ACTIVE_KEY_ID and FAMILY_MODEL_CREDENTIAL_KEYS_JSON"
            )
        try:
            from app.services.family_model_settings.network_policy import (
                decode_private_target_allowlist,
            )

            decode_private_target_allowlist(self.family_model_private_target_allowlist_json)
        except Exception:
            missing.append("FAMILY_MODEL_PRIVATE_TARGET_ALLOWLIST_JSON")
        if missing:
            unique_missing = ", ".join(dict.fromkeys(missing))
            raise ValueError(f"Unsafe production settings: set {unique_missing}")
        return self

    @computed_field  # type: ignore[misc]
    @property
    def database_url(self) -> str:
        username = quote_plus(self.mysql_user)
        password = quote_plus(self.mysql_password)
        credentials = username if not password else f"{username}:{password}"
        return (
            f"mysql+pymysql://{credentials}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}?charset=utf8mb4"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
