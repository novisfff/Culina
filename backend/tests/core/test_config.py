from __future__ import annotations

from app.core.config import Settings


def test_ai_supports_vision_defaults_to_true() -> None:
    settings = Settings()

    assert settings.ai_supports_vision is True


def test_empty_ai_supports_vision_env_value_is_unset() -> None:
    settings = Settings(ai_supports_vision="")

    assert settings.ai_supports_vision is None
