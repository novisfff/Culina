from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import DISABLED_SEARCH_PROVIDERS, get_settings
from app.core.utils import create_id
from app.models.domain import Food, FoodPlanItem, Ingredient, Recipe, SearchDocument
from app.services.search.documents import (
    SearchDocumentPayload,
    build_food_search_document,
    build_ingredient_search_document,
    build_meal_plan_search_document,
    build_recipe_search_document,
)
from app.services.search.vector_indexing import search_point_id
from app.services.search.vector_store import VectorStore, build_vector_store

logger = logging.getLogger(__name__)


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


def upsert_meal_plan_search_document(db: Session, item: FoodPlanItem) -> SearchDocument:
    return upsert_search_document(db, build_meal_plan_search_document(item, **_embedding_document_config()))


def delete_search_document(
    db: Session,
    *,
    family_id: str,
    entity_type: str,
    entity_id: str,
    delete_vector: bool = False,
    vector_store: VectorStore | None = None,
) -> None:
    document = db.scalar(
        select(SearchDocument).where(
            SearchDocument.family_id == family_id,
            SearchDocument.entity_type == entity_type,
            SearchDocument.entity_id == entity_id,
        )
    )
    if document is not None:
        db.delete(document)
    if delete_vector:
        delete_search_vector_point(entity_type=entity_type, entity_id=entity_id, vector_store=vector_store)


def _embedding_document_config() -> dict[str, object]:
    settings = get_settings()
    provider = settings.search_embedding_provider.strip().lower()
    if provider in DISABLED_SEARCH_PROVIDERS:
        return {"embedding_model": "", "embedding_dimensions": 0}
    return {
        "embedding_model": settings.search_embedding_model.strip(),
        "embedding_dimensions": settings.search_embedding_dimensions,
    }


def delete_search_vector_point(*, entity_type: str, entity_id: str, vector_store: VectorStore | None = None) -> None:
    if not entity_type or not entity_id:
        return
    if vector_store is None and not _should_delete_vector_point():
        return
    try:
        store = vector_store or build_vector_store()
        store.delete_point(point_id=search_point_id(entity_type, entity_id))
    except Exception as exc:
        logger.warning(
            "Failed to delete search vector point entity_type=%s entity_id=%s error=%s",
            entity_type,
            entity_id,
            exc,
        )


def _should_delete_vector_point() -> bool:
    settings = get_settings()
    return (
        settings.search_vector_backend.strip().lower() == "qdrant"
        and settings.search_embedding_provider.strip().lower() not in DISABLED_SEARCH_PROVIDERS
        and bool(settings.qdrant_url.strip())
        and bool(settings.qdrant_collection.strip())
    )
