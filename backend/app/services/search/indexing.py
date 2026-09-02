from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import create_id
from app.models.domain import Food, FoodPlanItem, Ingredient, Recipe, SearchDocument
from app.models.family_model_settings import FamilySearchProfileDocument
from app.services.search.documents import (
    SearchDocumentPayload,
    build_food_search_document,
    build_ingredient_search_document,
    build_meal_plan_search_document,
    build_recipe_search_document,
)
from app.services.search.vector_store import VectorStore

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
    # Vector lifecycle belongs exclusively to FamilySearchProfileDocument.
    # The legacy SearchDocument vector fields remain untouched for migration
    # downgrade compatibility and must not be used as a shared profile state.
    del is_new, hash_changed
    return document


def upsert_ingredient_search_document(db: Session, ingredient: Ingredient) -> SearchDocument:
    return upsert_search_document(db, build_ingredient_search_document(ingredient))


def upsert_food_search_document(db: Session, food: Food) -> SearchDocument:
    return upsert_search_document(db, build_food_search_document(food))


def upsert_recipe_search_document(db: Session, recipe: Recipe) -> SearchDocument:
    return upsert_search_document(db, build_recipe_search_document(recipe))


def upsert_meal_plan_search_document(db: Session, item: FoodPlanItem) -> SearchDocument:
    return upsert_search_document(db, build_meal_plan_search_document(item))


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
        profile_documents = list(
            db.scalars(
                select(FamilySearchProfileDocument).where(
                    FamilySearchProfileDocument.search_document_id == document.id
                )
            )
        )
        for profile_document in profile_documents:
            db.delete(profile_document)
        db.delete(document)
    # Collection cleanup is profile-aware and durable.  It cannot be done
    # against one global collection from this canonical-document boundary.
    del delete_vector, vector_store
