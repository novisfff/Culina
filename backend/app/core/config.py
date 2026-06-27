from __future__ import annotations

from functools import lru_cache
from urllib.parse import quote_plus

from pydantic import computed_field, field_validator, model_validator
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
    minio_endpoint: str = "127.0.0.1:9000"
    minio_access_key: str = "culina"
    minio_secret_key: str = "culina_local_minio_secret"
    minio_bucket: str = "culina-media"
    minio_secure: bool = False
    ai_provider: str = "disabled"
    ai_api_base: str = "https://api.openai.com/v1"
    ai_api_key: str = ""
    ai_model: str = ""
    ai_supports_vision: bool | None = True
    ai_timeout_seconds: float = 180.0
    ai_trace_enabled: bool = True
    ai_trace_capture_llm_exchanges: bool = False
    ai_trace_capture_message_content: bool = False
    ai_trace_capture_stream_chunks: bool = False
    ai_trace_capture_image_bytes: bool = False
    ai_trace_payload_mode: str = "redacted"
    ai_trace_retention_days: int = 7
    ai_trace_max_request_bytes: int = 1024 * 1024
    ai_trace_max_response_bytes: int = 1024 * 1024
    ai_image_reference_provider: str = "disabled"
    ai_image_reference_api_base: str = ""
    ai_image_reference_api_key: str = ""
    ai_image_reference_model: str = "wan2.6-image"
    ai_image_text_provider: str = "disabled"
    ai_image_text_api_base: str = ""
    ai_image_text_api_key: str = ""
    ai_image_text_model: str = "wan2.6-t2i"
    search_enabled: bool = True
    search_default_mode: str = "hybrid"
    search_keyword_backend: str = "mysql"
    search_vector_backend: str = "qdrant"
    search_vector_degraded_to_keyword: bool = True
    search_embedding_provider: str = "disabled"
    search_embedding_api_base: str = ""
    search_embedding_api_key: str = ""
    search_embedding_model: str = ""
    search_embedding_dimensions: int = 0
    search_embedding_timeout_seconds: float = 30.0
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "culina_search"
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

    @field_validator("ai_supports_vision", mode="before")
    @classmethod
    def normalize_optional_bool(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("search_embedding_dimensions", mode="before")
    @classmethod
    def normalize_optional_int(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return 0
        return value

    @model_validator(mode="after")
    def validate_safe_runtime_settings(self) -> "Settings":
        search_vector_backend = self.search_vector_backend.strip().lower()
        search_embedding_provider = self.search_embedding_provider.strip().lower()
        if self.search_enabled and search_vector_backend == "qdrant" and search_embedding_provider != "disabled":
            missing_search: list[str] = []
            if not self.search_embedding_model.strip():
                missing_search.append("SEARCH_EMBEDDING_MODEL")
            if self.search_embedding_dimensions <= 0:
                missing_search.append("SEARCH_EMBEDDING_DIMENSIONS")
            if not self.qdrant_url.strip():
                missing_search.append("QDRANT_URL")
            if not self.qdrant_collection.strip():
                missing_search.append("QDRANT_COLLECTION")
            if missing_search:
                unique_missing = ", ".join(dict.fromkeys(missing_search))
                raise ValueError(f"Invalid search vector settings: set {unique_missing}")

        environment = self.environment.strip().lower()
        if self.ai_trace_payload_mode.strip().lower() == "full" and environment not in LOCAL_ENVIRONMENTS:
            raise ValueError("Unsafe production settings: AI_TRACE_PAYLOAD_MODE=full is only allowed locally")
        if environment in LOCAL_ENVIRONMENTS:
            return self

        missing: list[str] = []
        if not self.mysql_password:
            missing.append("MYSQL_PASSWORD")
        if not self.jwt_secret:
            missing.append("JWT_SECRET")
        if self.jwt_secret in {"change-me", "culina-local-dev-secret"}:
            missing.append("JWT_SECRET")
        if not self.minio_secret_key or self.minio_secret_key == "culina_local_minio_secret":
            missing.append("MINIO_SECRET_KEY")
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
