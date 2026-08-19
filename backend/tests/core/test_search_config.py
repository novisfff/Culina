from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_qdrant_platform_defaults_are_retained_without_provider_settings() -> None:
    settings = Settings(_env_file=None)

    assert settings.search_hybrid_enabled is True
    assert settings.search_keyword_backend == "mysql"
    assert settings.search_vector_backend == "qdrant"
    assert settings.qdrant_url
    assert settings.qdrant_timeout_seconds == 10.0
    assert not hasattr(settings, "search_embedding_provider")
    assert not hasattr(settings, "search_rerank_provider")


def test_qdrant_requires_a_target_only_when_hybrid_vector_search_is_enabled() -> None:
    with pytest.raises(ValidationError, match="QDRANT_URL is required"):
        Settings(
            _env_file=None,
            search_hybrid_enabled=True,
            search_vector_backend="qdrant",
            qdrant_url="",
        )

    disabled = Settings(
        _env_file=None,
        search_hybrid_enabled=False,
        search_vector_backend="qdrant",
        qdrant_url="",
    )
    assert disabled.qdrant_url == ""


@pytest.mark.parametrize(
    ("field", "value", "message"),
    (
        ("search_keyword_backend", "postgres", "SEARCH_KEYWORD_BACKEND must be mysql"),
        ("search_vector_backend", "elasticsearch", "SEARCH_VECTOR_BACKEND must be qdrant or disabled"),
        ("qdrant_timeout_seconds", 0, "QDRANT_TIMEOUT_SECONDS must be positive"),
        (
            "family_model_qdrant_collection_prefix",
            "bad-prefix",
            "FAMILY_MODEL_QDRANT_COLLECTION_PREFIX",
        ),
    ),
)
def test_platform_search_safety_settings_are_validated(
    field: str,
    value: object,
    message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        Settings(_env_file=None, **{field: value})


def test_collection_prefix_accepts_qdrant_safe_identifier() -> None:
    settings = Settings(_env_file=None, family_model_qdrant_collection_prefix="culina_fsp2")

    assert settings.family_model_qdrant_collection_prefix == "culina_fsp2"
