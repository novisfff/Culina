from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_search_embedding_dimensions_empty_string_defaults_to_zero() -> None:
    settings = Settings(_env_file=None, search_embedding_dimensions="")

    assert settings.search_embedding_dimensions == 0


def test_disabled_search_embedding_allows_hybrid_keyword_degradation_defaults() -> None:
    settings = Settings(
        _env_file=None,
        search_default_mode="hybrid",
        search_vector_backend="qdrant",
        search_embedding_provider="disabled",
        search_embedding_model="",
        search_embedding_dimensions="",
    )

    assert settings.search_default_mode == "hybrid"
    assert settings.search_embedding_provider == "disabled"
    assert settings.search_embedding_dimensions == 0


def test_enabled_qdrant_embedding_requires_model_and_dimensions() -> None:
    with pytest.raises(ValidationError, match="SEARCH_EMBEDDING_MODEL.*SEARCH_EMBEDDING_DIMENSIONS"):
        Settings(
            _env_file=None,
            search_vector_backend="qdrant",
            search_embedding_provider="openai",
            search_embedding_model="",
            search_embedding_dimensions=0,
        )


def test_enabled_qdrant_embedding_requires_qdrant_target() -> None:
    with pytest.raises(ValidationError, match="QDRANT_URL.*QDRANT_COLLECTION"):
        Settings(
            _env_file=None,
            search_vector_backend="qdrant",
            search_embedding_provider="openai",
            search_embedding_model="embedding-model",
            search_embedding_dimensions=1024,
            qdrant_url="",
            qdrant_collection="",
        )


def test_non_qdrant_vector_backend_does_not_require_embedding_dimensions() -> None:
    settings = Settings(
        _env_file=None,
        search_vector_backend="disabled",
        search_embedding_provider="openai",
        search_embedding_model="",
        search_embedding_dimensions=0,
    )

    assert settings.search_vector_backend == "disabled"
