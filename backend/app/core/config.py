from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    mysql_host: str = "192.168.30.120"
    mysql_port: int = 3306
    mysql_database: str = "culina"
    mysql_user: str = "root"
    mysql_password: str = "156125"
    jwt_secret: str = "culina-local-dev-secret"
    access_token_expire_minutes: int = 60 * 24 * 7
    media_root: str = "storage/uploads"
    ai_provider: str = "disabled"
    ai_api_base: str = "https://api.openai.com/v1"
    ai_api_key: str = ""
    ai_model: str = ""
    ai_image_reference_provider: str = "disabled"
    ai_image_reference_api_base: str = "https://dashscope.aliyuncs.com/api/v1"
    ai_image_reference_api_key: str = ""
    ai_image_reference_model: str = "wan2.6-image"
    ai_image_text_provider: str = "disabled"
    ai_image_text_api_base: str = "https://dashscope.aliyuncs.com/api/v1"
    ai_image_text_api_key: str = ""
    ai_image_text_model: str = "wan2.6-t2i"
    frontend_origin: str = "http://localhost:5173"

    @computed_field  # type: ignore[misc]
    @property
    def database_url(self) -> str:
        return (
            f"mysql+pymysql://{self.mysql_user}:{self.mysql_password}"
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
