from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from urllib.parse import quote_plus

from pydantic import computed_field, model_validator
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
    media_root: str = "storage/uploads"
    media_max_upload_bytes: int = 10 * 1024 * 1024
    ai_provider: str = "disabled"
    ai_api_base: str = "https://api.openai.com/v1"
    ai_api_key: str = ""
    ai_model: str = ""
    ai_timeout_seconds: float = 180.0
    ai_image_reference_provider: str = "disabled"
    ai_image_reference_api_base: str = ""
    ai_image_reference_api_key: str = ""
    ai_image_reference_model: str = "wan2.6-image"
    ai_image_text_provider: str = "disabled"
    ai_image_text_api_base: str = ""
    ai_image_text_api_key: str = ""
    ai_image_text_model: str = "wan2.6-t2i"
    frontend_origin: str = "http://localhost:5173"

    @model_validator(mode="after")
    def validate_safe_runtime_settings(self) -> "Settings":
        environment = self.environment.strip().lower()
        if environment in LOCAL_ENVIRONMENTS:
            return self

        missing: list[str] = []
        if not self.mysql_password:
            missing.append("MYSQL_PASSWORD")
        if not self.jwt_secret:
            missing.append("JWT_SECRET")
        if self.jwt_secret in {"change-me", "culina-local-dev-secret"}:
            missing.append("JWT_SECRET")
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

    @computed_field  # type: ignore[misc]
    @property
    def backend_root(self) -> Path:
        return Path(__file__).resolve().parents[2]

    @computed_field  # type: ignore[misc]
    @property
    def resolved_media_root(self) -> Path:
        return self.backend_root / self.media_root


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
