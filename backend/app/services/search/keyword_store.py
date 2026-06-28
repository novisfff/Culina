from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.sql.elements import TextClause
from sqlalchemy.orm import Session

from app.models.domain import Food, FoodPlanItem, Ingredient, Recipe, SearchDocument


@dataclass(frozen=True)
class KeywordSearchHit:
    entity_type: str
    entity_id: str
    keyword_score: float
    matched_fields: tuple[str, ...]


def search_keyword_documents(
    db: Session,
    *,
    family_id: str,
    query: str,
    scopes: list[str],
    limit: int = 80,
) -> list[KeywordSearchHit]:
    normalized_query = _normalize_query(query)
    if not normalized_query or not scopes or limit <= 0:
        return []
    if db.get_bind().dialect.name == "mysql":
        try:
            fulltext_hits = _search_mysql_fulltext_documents(
                db,
                family_id=family_id,
                query=normalized_query,
                scopes=scopes,
                limit=limit,
            )
            if _should_use_substring_fallback(normalized_query):
                substring_hits = _search_like_documents(
                    db,
                    family_id=family_id,
                    query=normalized_query,
                    scopes=scopes,
                    limit=limit,
                )
                compact_hits = _search_compact_documents(
                    db,
                    family_id=family_id,
                    query=normalized_query,
                    scopes=scopes,
                    limit=limit,
                )
                return _merge_keyword_hits([*fulltext_hits, *substring_hits], compact_hits, limit=limit)
            return fulltext_hits
        except SQLAlchemyError:
            pass
    like_hits = _search_like_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=limit,
    )
    if not _should_use_substring_fallback(normalized_query):
        return like_hits
    compact_hits = _search_compact_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=limit,
    )
    return _merge_keyword_hits(like_hits, compact_hits, limit=limit)


def search_exact_name_documents(
    db: Session,
    *,
    family_id: str,
    user_id: str | None = None,
    query: str,
    scopes: list[str],
    limit: int = 80,
) -> list[KeywordSearchHit]:
    normalized_query = _normalize_query(query)
    if not normalized_query or not scopes or limit <= 0:
        return []
    hits: list[KeywordSearchHit] = []
    for scope in scopes:
        if len(hits) >= limit:
            break
        remaining = limit - len(hits)
        if scope == "ingredient":
            rows = db.scalars(
                select(Ingredient.id)
                .where(
                    Ingredient.family_id == family_id,
                    func.lower(func.trim(Ingredient.name)) == normalized_query,
                )
                .order_by(Ingredient.updated_at.desc(), Ingredient.id.asc())
                .limit(remaining)
            )
            hits.extend(
                KeywordSearchHit(
                    entity_type="ingredient",
                    entity_id=ingredient_id,
                    keyword_score=1.0,
                    matched_fields=("title_text",),
                )
                for ingredient_id in rows
            )
        elif scope == "food":
            rows = db.scalars(
                select(Food.id)
                .where(
                    Food.family_id == family_id,
                    func.lower(func.trim(Food.name)) == normalized_query,
                )
                .order_by(Food.updated_at.desc(), Food.id.asc())
                .limit(remaining)
            )
            hits.extend(
                KeywordSearchHit(
                    entity_type="food",
                    entity_id=food_id,
                    keyword_score=1.0,
                    matched_fields=("title_text",),
                )
                for food_id in rows
            )
        elif scope == "recipe":
            rows = db.scalars(
                select(Recipe.id)
                .where(
                    Recipe.family_id == family_id,
                    func.lower(func.trim(Recipe.title)) == normalized_query,
                )
                .order_by(Recipe.updated_at.desc(), Recipe.id.asc())
                .limit(remaining)
            )
            hits.extend(
                KeywordSearchHit(
                    entity_type="recipe",
                    entity_id=recipe_id,
                    keyword_score=1.0,
                    matched_fields=("title_text",),
                )
                for recipe_id in rows
            )
        elif scope == "meal_plan" and user_id:
            rows = db.scalars(
                select(FoodPlanItem.id)
                .where(
                    FoodPlanItem.family_id == family_id,
                    FoodPlanItem.user_id == user_id,
                    or_(
                        func.lower(func.trim(FoodPlanItem.note)) == normalized_query,
                        FoodPlanItem.food.has(func.lower(func.trim(Food.name)) == normalized_query),
                        FoodPlanItem.food.has(Food.recipe.has(func.lower(func.trim(Recipe.title)) == normalized_query)),
                    ),
                )
                .order_by(FoodPlanItem.updated_at.desc(), FoodPlanItem.id.asc())
                .limit(remaining)
            )
            hits.extend(
                KeywordSearchHit(
                    entity_type="meal_plan",
                    entity_id=item_id,
                    keyword_score=1.0,
                    matched_fields=("title_text",),
                )
                for item_id in rows
            )
    return hits


def _search_like_documents(
    db: Session,
    *,
    family_id: str,
    query: str,
    scopes: list[str],
    limit: int,
) -> list[KeywordSearchHit]:
    like_pattern = f"%{query}%"
    statement = (
        select(SearchDocument)
        .where(
            SearchDocument.family_id == family_id,
            SearchDocument.entity_type.in_(scopes),
            or_(
                SearchDocument.title_text.ilike(like_pattern),
                SearchDocument.keyword_text.ilike(like_pattern),
                SearchDocument.detail_text.ilike(like_pattern),
            ),
        )
        .order_by(SearchDocument.updated_at.desc(), SearchDocument.entity_id.asc())
        .limit(limit)
    )
    hits = []
    for document in db.scalars(statement):
        matched_fields = _matched_fields(document, query)
        hits.append(
            KeywordSearchHit(
                entity_type=document.entity_type,
                entity_id=document.entity_id,
                keyword_score=_keyword_score(document.title_text, query, matched_fields),
                matched_fields=tuple(matched_fields),
            )
        )
    hits.sort(key=lambda item: (-item.keyword_score, item.entity_id))
    return hits


def _search_compact_documents(
    db: Session,
    *,
    family_id: str,
    query: str,
    scopes: list[str],
    limit: int,
) -> list[KeywordSearchHit]:
    compact_query = _compact_query(query)
    if not compact_query:
        return []
    scan_limit = max(limit * 10, 300)
    statement = (
        select(SearchDocument)
        .where(
            SearchDocument.family_id == family_id,
            SearchDocument.entity_type.in_(scopes),
        )
        .order_by(SearchDocument.updated_at.desc(), SearchDocument.entity_id.asc())
        .limit(scan_limit)
    )
    hits: list[KeywordSearchHit] = []
    for document in db.scalars(statement):
        matched_fields = _compact_matched_fields(document, compact_query)
        if not matched_fields:
            continue
        hits.append(
            KeywordSearchHit(
                entity_type=document.entity_type,
                entity_id=document.entity_id,
                keyword_score=_keyword_score(document.title_text, query, matched_fields),
                matched_fields=tuple(matched_fields),
            )
        )
        if len(hits) >= limit:
            break
    hits.sort(key=lambda item: (-item.keyword_score, item.entity_type, item.entity_id))
    return hits


def _search_mysql_fulltext_documents(
    db: Session,
    *,
    family_id: str,
    query: str,
    scopes: list[str],
    limit: int,
) -> list[KeywordSearchHit]:
    statement = _mysql_fulltext_statement().bindparams(bindparam("scopes", expanding=True))
    rows = db.execute(
        statement,
        {
            "family_id": family_id,
            "scopes": scopes,
            "query": query,
            "limit": limit,
        },
    ).mappings()
    hits: list[KeywordSearchHit] = []
    for row in rows:
        matched_fields = _fulltext_matched_fields(
            title_score=row.get("title_score"),
            keyword_score=row.get("keyword_text_score"),
            detail_score=row.get("detail_score"),
        )
        if not matched_fields:
            continue
        hits.append(
            KeywordSearchHit(
                entity_type=str(row["entity_type"]),
                entity_id=str(row["entity_id"]),
                keyword_score=_keyword_score_from_fulltext(
                    title_text=str(row.get("title_text") or ""),
                    query=query,
                    matched_fields=matched_fields,
                    title_score=row.get("title_score"),
                    keyword_text_score=row.get("keyword_text_score"),
                    detail_score=row.get("detail_score"),
                ),
                matched_fields=tuple(matched_fields),
            )
        )
    return hits


def _should_use_substring_fallback(query: str) -> bool:
    return len(query) <= 2 or any("\u4e00" <= char <= "\u9fff" for char in query)


def _merge_keyword_hits(
    primary_hits: list[KeywordSearchHit],
    fallback_hits: list[KeywordSearchHit],
    *,
    limit: int,
) -> list[KeywordSearchHit]:
    by_key: dict[tuple[str, str], KeywordSearchHit] = {}
    for hit in [*primary_hits, *fallback_hits]:
        key = (hit.entity_type, hit.entity_id)
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = hit
            continue
        matched_fields = tuple(
            field
            for field in ("title_text", "keyword_text", "detail_text")
            if field in existing.matched_fields or field in hit.matched_fields
        )
        by_key[key] = KeywordSearchHit(
            entity_type=hit.entity_type,
            entity_id=hit.entity_id,
            keyword_score=max(existing.keyword_score, hit.keyword_score),
            matched_fields=matched_fields,
        )
    return sorted(by_key.values(), key=lambda item: (-item.keyword_score, item.entity_type, item.entity_id))[:limit]


def _mysql_fulltext_statement() -> TextClause:
    return text(
        """
        SELECT
            entity_type,
            entity_id,
            title_text,
            MATCH(title_text) AGAINST (:query IN NATURAL LANGUAGE MODE) AS title_score,
            MATCH(keyword_text) AGAINST (:query IN NATURAL LANGUAGE MODE) AS keyword_text_score,
            MATCH(detail_text) AGAINST (:query IN NATURAL LANGUAGE MODE) AS detail_score
        FROM search_documents
        WHERE family_id = :family_id
          AND entity_type IN :scopes
          AND (
            MATCH(title_text) AGAINST (:query IN NATURAL LANGUAGE MODE) > 0
            OR MATCH(keyword_text) AGAINST (:query IN NATURAL LANGUAGE MODE) > 0
            OR MATCH(detail_text) AGAINST (:query IN NATURAL LANGUAGE MODE) > 0
          )
        ORDER BY (
            MATCH(title_text) AGAINST (:query IN NATURAL LANGUAGE MODE) * 0.55
            + MATCH(keyword_text) AGAINST (:query IN NATURAL LANGUAGE MODE) * 0.35
            + MATCH(detail_text) AGAINST (:query IN NATURAL LANGUAGE MODE) * 0.10
        ) DESC, updated_at DESC, entity_id ASC
        LIMIT :limit
        """
    )


def _normalize_query(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _matched_fields(document: SearchDocument, query: str) -> list[str]:
    matches = []
    for field in ("title_text", "keyword_text", "detail_text"):
        value = str(getattr(document, field) or "").lower()
        if query in value:
            matches.append(field)
    return matches


def _compact_matched_fields(document: SearchDocument, compact_query: str) -> list[str]:
    matches = []
    for field in ("title_text", "keyword_text", "detail_text"):
        value = _compact_query(getattr(document, field) or "")
        if compact_query in value:
            matches.append(field)
    return matches


def _compact_query(value: object) -> str:
    return "".join(char for char in _normalize_query(str(value or "")) if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def _fulltext_matched_fields(*, title_score: object, keyword_score: object, detail_score: object) -> list[str]:
    matches = []
    if _positive_score(title_score):
        matches.append("title_text")
    if _positive_score(keyword_score):
        matches.append("keyword_text")
    if _positive_score(detail_score):
        matches.append("detail_text")
    return matches


def _keyword_score(title_text: str, query: str, matched_fields: list[str]) -> float:
    score = 0.0
    title = (title_text or "").lower()
    if title == query:
        score += 1.0
    elif title.startswith(query):
        score += 0.85
    elif query in title:
        score += 0.70
    if "title_text" in matched_fields:
        score += 0.55
    if "keyword_text" in matched_fields:
        score += 0.35
    if "detail_text" in matched_fields:
        score += 0.10
    return min(score, 1.0)


def _keyword_score_from_fulltext(
    *,
    title_text: str,
    query: str,
    matched_fields: list[str],
    title_score: object,
    keyword_text_score: object,
    detail_score: object,
) -> float:
    base_score = (
        min(_float_score(title_score), 1.0) * 0.55
        + min(_float_score(keyword_text_score), 1.0) * 0.35
        + min(_float_score(detail_score), 1.0) * 0.10
    )
    title = title_text.lower()
    if title == query:
        base_score += 1.0
    elif title.startswith(query):
        base_score += 0.85
    elif "title_text" in matched_fields and query in title:
        base_score += 0.70
    if not base_score:
        base_score = _keyword_score(title_text, query, matched_fields)
    return min(base_score, 1.0)


def _positive_score(value: object) -> bool:
    return _float_score(value) > 0


def _float_score(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
