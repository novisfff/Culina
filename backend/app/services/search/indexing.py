from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.utils import create_id
from app.models.domain import Food, Ingredient, Recipe, SearchDocument
from app.services.search.documents import (
    SearchDocumentPayload,
    build_food_search_document,
    build_ingredient_search_document,
    build_recipe_search_document,
)


def upsert_search_document(db: Session, payload: SearchDocumentPayload) -> SearchDocument:
    document = db.scalar(
        select(SearchDocument).where(
            SearchDocument.family_id == payload.family_id,
            SearchDocument.entity_type == payload.entity_type,
            SearchDocument.entity_id == payload.entity_id,
        )
    )
    if document is None:
        document = SearchDocument(
            id=create_id("search-doc"),
            family_id=payload.family_id,
            entity_type=payload.entity_type,
            entity_id=payload.entity_id,
            content_hash=payload.content_hash,
            document_builder_version=payload.document_builder_version,
        )
        db.add(document)

    is_new = document.created_at is None
    hash_changed = document.content_hash != payload.content_hash
    document.title_text = payload.title_text
    document.keyword_text = payload.keyword_text
    document.detail_text = payload.detail_text
    document.semantic_text = payload.semantic_text
    document.metadata_json = payload.metadata_json
    document.content_hash = payload.content_hash
    document.document_builder_version = payload.document_builder_version
    if is_new or hash_changed:
        document.embedding_model = payload.embedding_model
        document.embedding_dimensions = payload.embedding_dimensions
    if hash_changed or document.vector_status == "disabled":
        document.vector_status = "pending"
        document.vector_error = None
        document.indexed_at = None
    return document


def upsert_ingredient_search_document(db: Session, ingredient: Ingredient) -> SearchDocument:
    return upsert_search_document(db, build_ingredient_search_document(ingredient, **_embedding_document_config()))


def upsert_food_search_document(db: Session, food: Food) -> SearchDocument:
    return upsert_search_document(db, build_food_search_document(food, **_embedding_document_config()))


def upsert_recipe_search_document(db: Session, recipe: Recipe) -> SearchDocument:
    return upsert_search_document(db, build_recipe_search_document(recipe, **_embedding_document_config()))


def delete_search_document(db: Session, *, family_id: str, entity_type: str, entity_id: str) -> None:
    document = db.scalar(
        select(SearchDocument).where(
            SearchDocument.family_id == family_id,
            SearchDocument.entity_type == entity_type,
            SearchDocument.entity_id == entity_id,
        )
    )
    if document is not None:
        db.delete(document)


def _embedding_document_config() -> dict[str, object]:
    settings = get_settings()
    provider = settings.search_embedding_provider.strip().lower()
    if provider == "disabled":
        return {"embedding_model": "", "embedding_dimensions": 0}
    return {
        "embedding_model": settings.search_embedding_model.strip(),
        "embedding_dimensions": settings.search_embedding_dimensions,
    }
