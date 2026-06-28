from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Food, Ingredient, Recipe
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.search import SearchIndexJobResponse, SearchResponseOut
from app.services.search.hybrid import HybridSearchResult, hybrid_search
from app.services.search.jobs import get_search_index_job, list_active_search_index_jobs, retry_failed_search_index_job
from app.services.serializers import serialize_food, serialize_ingredient, serialize_recipe

router = APIRouter(tags=["search"])

SEARCH_SCOPES = {"ingredients": "ingredient", "foods": "food", "recipes": "recipe", "ingredient": "ingredient", "food": "food", "recipe": "recipe"}
DEFAULT_SCOPES = ["recipe", "food", "ingredient"]


@router.get("/api/search", response_model=SearchResponseOut)
def search(
    q: str = Query(default="", max_length=100),
    scopes: str = Query(default="recipes,foods,ingredients"),
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0, le=500),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    query = q.strip()
    normalized_scopes = _parse_scopes(scopes)
    if not query:
        return {"items": [], "total": 0, "query": query, "search_mode": "hybrid", "degraded": False}

    search_result = hybrid_search(
        db,
        family_id=membership.family_id,
        query=query,
        scopes=normalized_scopes,
        limit=limit,
        offset=offset,
    )
    entity_payloads = _load_entities(db, family_id=membership.family_id, hits=search_result.items)
    items = []
    for item in search_result.items:
        entity = entity_payloads.get((item.entity_type, item.entity_id))
        if entity is None:
            continue
        items.append(
            {
                "entity_type": item.entity_type,
                "entity_id": item.entity_id,
                "score": item.score,
                "keyword_score": item.keyword_score,
                "semantic_score": item.semantic_score,
                "business_score": item.business_score,
                "match_reason": item.match_reason,
                "entity": entity,
            }
        )
    return {
        "items": items,
        "total": search_result.total,
        "query": search_result.query,
        "search_mode": search_result.search_mode,
        "degraded": search_result.degraded,
    }


def _parse_scopes(value: str) -> list[str]:
    scopes = []
    for raw_scope in value.split(","):
        normalized = raw_scope.strip().lower()
        if not normalized:
            continue
        scope = SEARCH_SCOPES.get(normalized)
        if scope is None:
            raise HTTPException(status_code=400, detail=f"不支持的搜索范围：{raw_scope.strip()}")
        if scope and scope not in scopes:
            scopes.append(scope)
    return scopes or list(DEFAULT_SCOPES)


def _load_entities(db: Session, *, family_id: str, hits: list[HybridSearchResult]) -> dict[tuple[str, str], dict]:
    ids_by_type: dict[str, list[str]] = {"ingredient": [], "food": [], "recipe": []}
    for hit in hits:
        if hit.entity_id not in ids_by_type.get(hit.entity_type, []):
            ids_by_type[hit.entity_type].append(hit.entity_id)

    payloads: dict[tuple[str, str], dict] = {}
    if ids_by_type["ingredient"]:
        ingredients = list(
            db.scalars(
                select(Ingredient).where(
                    Ingredient.family_id == family_id,
                    Ingredient.id.in_(ids_by_type["ingredient"]),
                )
            )
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="ingredient", entity_ids=[item.id for item in ingredients]))
        payloads.update({("ingredient", item.id): serialize_ingredient(item, media_map) for item in ingredients})

    if ids_by_type["food"]:
        foods = list(
            db.scalars(
                select(Food).where(
                    Food.family_id == family_id,
                    Food.id.in_(ids_by_type["food"]),
                )
            )
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="food", entity_ids=[item.id for item in foods]))
        payloads.update({("food", item.id): serialize_food(item, media_map) for item in foods})

    if ids_by_type["recipe"]:
        recipes = list(
            db.scalars(
                select(Recipe)
                .where(
                    Recipe.family_id == family_id,
                    Recipe.id.in_(ids_by_type["recipe"]),
                )
                .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
            )
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="recipe", entity_ids=[item.id for item in recipes]))
        payloads.update({("recipe", item.id): serialize_recipe(item, media_map) for item in recipes})
    return payloads


def _render_search_index_job_response(job) -> dict:
    return {
        "job_id": job.id,
        "status": job.status,
        "error": job.error,
        "entity_type": job.entity_type,
        "entity_id": job.entity_id,
        "target_name": job.target_name,
        "vector_status": job.vector_status,
    }


@router.get("/api/search/index-jobs/active", response_model=list[SearchIndexJobResponse])
def list_active_search_index_job_notifications(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    return [_render_search_index_job_response(job) for job in list_active_search_index_jobs(db, family_id=membership.family_id)]


@router.get("/api/search/index-jobs/{job_id}", response_model=SearchIndexJobResponse)
def get_search_index_job_notification(
    job_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    job = get_search_index_job(db, family_id=membership.family_id, job_id=job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Search index job not found")
    return _render_search_index_job_response(job)


@router.post("/api/search/index-jobs/{job_id}/retry", response_model=SearchIndexJobResponse)
def retry_search_index_job_notification(
    job_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    try:
        job = retry_failed_search_index_job(db, family_id=membership.family_id, job_id=job_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Search index job not found")
    commit_session(db)
    return _render_search_index_job_response(job)
