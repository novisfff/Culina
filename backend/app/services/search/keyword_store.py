from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import bindparam, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.sql.elements import TextClause
from sqlalchemy.orm import Session

from app.models.domain import SearchDocument


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
            return _search_mysql_fulltext_documents(
                db,
                family_id=family_id,
                query=normalized_query,
                scopes=scopes,
                limit=limit,
            )
        except SQLAlchemyError:
            pass
    return _search_like_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=limit,
    )


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
