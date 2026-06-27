from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.core.config import get_settings


class VectorStoreUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class VectorSearchHit:
    entity_type: str
    entity_id: str
    semantic_score: float
    semantic_rank: int


@dataclass(frozen=True)
class VectorPoint:
    point_id: str
    payload: dict[str, object]


@dataclass(frozen=True)
class VectorPointPage:
    points: list[VectorPoint]
    next_page_offset: object | None = None


class VectorStore(Protocol):
    def ensure_collection(self, *, vector_size: int) -> None:
        ...

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        ...

    def delete_point(self, *, point_id: str) -> None:
        ...

    def scroll_points(
        self,
        *,
        family_id: str,
        scopes: list[str],
        limit: int,
        offset: object | None = None,
    ) -> VectorPointPage:
        ...

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        ...


class DisabledVectorStore:
    def ensure_collection(self, *, vector_size: int) -> None:
        del vector_size
        raise VectorStoreUnavailableError("search vector store disabled")

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        del point_id, vector, payload
        raise VectorStoreUnavailableError("search vector store disabled")

    def delete_point(self, *, point_id: str) -> None:
        del point_id
        raise VectorStoreUnavailableError("search vector store disabled")

    def scroll_points(
        self,
        *,
        family_id: str,
        scopes: list[str],
        limit: int,
        offset: object | None = None,
    ) -> VectorPointPage:
        del family_id, scopes, limit, offset
        raise VectorStoreUnavailableError("search vector store disabled")

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit
        raise VectorStoreUnavailableError("search vector store disabled")


class QdrantVectorStore:
    def __init__(self, *, url: str, api_key: str, collection: str, timeout_seconds: float) -> None:
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.collection = collection
        self.timeout = httpx.Timeout(max(timeout_seconds, 5.0), connect=5.0)

    def ensure_collection(self, *, vector_size: int) -> None:
        if vector_size <= 0:
            raise VectorStoreUnavailableError("qdrant vector size must be positive")
        headers = self._headers()
        try:
            with httpx.Client(timeout=self.timeout) as client:
                get_response = client.get(f"{self.url}/collections/{self.collection}", headers=headers)
                if get_response.status_code == 404:
                    create_response = client.put(
                        f"{self.url}/collections/{self.collection}",
                        headers=headers,
                        json={"vectors": {"size": vector_size, "distance": "Cosine"}},
                    )
                    create_response.raise_for_status()
                    for field_name in ("family_id", "entity_type"):
                        client.put(
                            f"{self.url}/collections/{self.collection}/index",
                            headers=headers,
                            json={"field_name": field_name, "field_schema": "keyword"},
                        ).raise_for_status()
                    return
                get_response.raise_for_status()
                existing_size = _collection_vector_size(get_response.json())
                if existing_size is not None and existing_size != vector_size:
                    raise VectorStoreUnavailableError(
                        f"qdrant collection vector size mismatch: existing={existing_size} expected={vector_size}"
                    )
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise VectorStoreUnavailableError(str(exc)) from exc

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        if not point_id or not vector:
            raise VectorStoreUnavailableError("qdrant point id and vector are required")
        body = {
            "points": [
                {"id": _qdrant_point_id(point_id), "vector": vector, "payload": _payload_with_point_id(payload, point_id)}
            ]
        }
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.put(
                    f"{self.url}/collections/{self.collection}/points?wait=true",
                    headers=self._headers(),
                    json=body,
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise VectorStoreUnavailableError(str(exc)) from exc

    def delete_point(self, *, point_id: str) -> None:
        if not point_id:
            return
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.url}/collections/{self.collection}/points/delete?wait=true",
                    headers=self._headers(),
                    json={"points": [_qdrant_point_id(point_id)]},
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise VectorStoreUnavailableError(str(exc)) from exc

    def scroll_points(
        self,
        *,
        family_id: str,
        scopes: list[str],
        limit: int,
        offset: object | None = None,
    ) -> VectorPointPage:
        if not scopes or limit <= 0:
            return VectorPointPage(points=[])
        payload: dict[str, object] = {
            "limit": limit,
            "with_payload": True,
            "with_vector": False,
            "filter": {
                "must": [
                    {"key": "family_id", "match": {"value": family_id}},
                    {"key": "entity_type", "match": {"any": scopes}},
                ]
            },
        }
        if offset is not None:
            payload["offset"] = offset
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(f"{self.url}/collections/{self.collection}/points/scroll", headers=self._headers(), json=payload)
                response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise VectorStoreUnavailableError(str(exc)) from exc
        body = response.json()
        result = body.get("result")
        if not isinstance(result, dict):
            raise VectorStoreUnavailableError("qdrant scroll response missing result")
        raw_points = result.get("points")
        if not isinstance(raw_points, list):
            raise VectorStoreUnavailableError("qdrant scroll response missing points")
        points = []
        for item in raw_points:
            if not isinstance(item, dict):
                continue
            point_payload = item.get("payload")
            if not isinstance(point_payload, dict):
                continue
            point_id = str(point_payload.get("_culina_point_id") or item.get("id") or "")
            if point_id:
                points.append(VectorPoint(point_id=point_id, payload=point_payload))
        return VectorPointPage(points=points, next_page_offset=result.get("next_page_offset"))

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        if not vector or not scopes or limit <= 0:
            return []
        headers = {"api-key": self.api_key} if self.api_key else {}
        payload = {
            "vector": vector,
            "limit": limit,
            "with_payload": True,
            "filter": {
                "must": [
                    {"key": "family_id", "match": {"value": family_id}},
                    {"key": "entity_type", "match": {"any": scopes}},
                ]
            },
        }
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(f"{self.url}/collections/{self.collection}/points/search", headers=headers, json=payload)
                response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise VectorStoreUnavailableError(str(exc)) from exc
        body = response.json()
        result = body.get("result")
        if not isinstance(result, list):
            raise VectorStoreUnavailableError("qdrant response missing result")
        hits: list[VectorSearchHit] = []
        for rank, item in enumerate(result, start=1):
            if not isinstance(item, dict):
                continue
            payload = item.get("payload")
            if not isinstance(payload, dict):
                continue
            entity_type = str(payload.get("entity_type") or "")
            entity_id = str(payload.get("entity_id") or "")
            if entity_type not in scopes or not entity_id:
                continue
            hits.append(
                VectorSearchHit(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    semantic_score=_normalize_qdrant_score(item.get("score")),
                    semantic_rank=rank,
                )
            )
        return hits

    def _headers(self) -> dict[str, str]:
        return {"api-key": self.api_key} if self.api_key else {}


def _normalize_qdrant_score(value: object) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(score, 1.0))


def _qdrant_point_id(point_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"culina-search:{point_id}"))


def _payload_with_point_id(payload: dict[str, object], point_id: str) -> dict[str, object]:
    enriched = dict(payload)
    enriched["_culina_point_id"] = point_id
    return enriched


def _collection_vector_size(body: object) -> int | None:
    if not isinstance(body, dict):
        return None
    result = body.get("result")
    if not isinstance(result, dict):
        return None
    config = result.get("config")
    if not isinstance(config, dict):
        return None
    params = config.get("params")
    if not isinstance(params, dict):
        return None
    vectors = params.get("vectors")
    if not isinstance(vectors, dict):
        return None
    size = vectors.get("size")
    if isinstance(size, int):
        return size
    for named_vector in vectors.values():
        if isinstance(named_vector, dict) and isinstance(named_vector.get("size"), int):
            return named_vector["size"]
    return None


def build_vector_store() -> VectorStore:
    settings = get_settings()
    if settings.search_vector_backend.strip().lower() != "qdrant":
        return DisabledVectorStore()
    if not settings.qdrant_url or not settings.qdrant_collection:
        return DisabledVectorStore()
    return QdrantVectorStore(
        url=settings.qdrant_url,
        api_key=settings.qdrant_api_key,
        collection=settings.qdrant_collection,
        timeout_seconds=settings.qdrant_timeout_seconds,
    )
