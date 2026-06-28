from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5

import pytest

from app.services.search.vector_store import QdrantVectorStore, VectorStoreUnavailableError


class FakeResponse:
    def __init__(self, *, status_code: int = 200, body: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self.body = body or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self.body


class FakeHttpxClient:
    requests: list[tuple[str, str, dict[str, Any] | None, dict[str, str] | None]] = []
    responses: list[FakeResponse] = []

    def __init__(self, *, timeout: object) -> None:
        self.timeout = timeout

    def __enter__(self) -> "FakeHttpxClient":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    def get(self, url: str, *, headers: dict[str, str] | None = None) -> FakeResponse:
        return self._request("GET", url, headers=headers)

    def put(self, url: str, *, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None) -> FakeResponse:
        return self._request("PUT", url, json=json, headers=headers)

    def post(self, url: str, *, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None) -> FakeResponse:
        return self._request("POST", url, json=json, headers=headers)

    @classmethod
    def _request(
        cls,
        method: str,
        url: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> FakeResponse:
        cls.requests.append((method, url, json, headers))
        if not cls.responses:
            return FakeResponse()
        return cls.responses.pop(0)


@pytest.fixture(autouse=True)
def fake_httpx_client(monkeypatch: pytest.MonkeyPatch):
    FakeHttpxClient.requests = []
    FakeHttpxClient.responses = []
    monkeypatch.setattr("app.services.search.vector_store.httpx.Client", FakeHttpxClient)


def _store() -> QdrantVectorStore:
    return QdrantVectorStore(url="http://qdrant:6333", api_key="secret", collection="culina_search", timeout_seconds=1)


def test_ensure_collection_creates_collection_and_payload_indexes() -> None:
    FakeHttpxClient.responses = [FakeResponse(status_code=404), FakeResponse(), FakeResponse(), FakeResponse(), FakeResponse()]

    _store().ensure_collection(vector_size=3)

    assert FakeHttpxClient.requests == [
        ("GET", "http://qdrant:6333/collections/culina_search", None, {"api-key": "secret"}),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search",
            {"vectors": {"size": 3, "distance": "Cosine"}},
            {"api-key": "secret"},
        ),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "family_id", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "entity_type", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "user_id", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
    ]


def test_ensure_collection_refreshes_payload_indexes_for_existing_collection() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(body={"result": {"config": {"params": {"vectors": {"size": 3, "distance": "Cosine"}}}}}),
        FakeResponse(),
        FakeResponse(),
        FakeResponse(),
    ]

    _store().ensure_collection(vector_size=3)

    assert FakeHttpxClient.requests == [
        ("GET", "http://qdrant:6333/collections/culina_search", None, {"api-key": "secret"}),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "family_id", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "entity_type", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
        (
            "PUT",
            "http://qdrant:6333/collections/culina_search/index",
            {"field_name": "user_id", "field_schema": "keyword"},
            {"api-key": "secret"},
        ),
    ]


def test_ensure_collection_rejects_existing_collection_with_wrong_vector_size() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(body={"result": {"config": {"params": {"vectors": {"size": 2, "distance": "Cosine"}}}}})
    ]

    with pytest.raises(VectorStoreUnavailableError, match="vector size mismatch"):
        _store().ensure_collection(vector_size=3)


def test_upsert_maps_business_point_id_to_qdrant_uuid_and_stores_original_id() -> None:
    _store().upsert_point(
        point_id="recipe:recipe-1",
        vector=[0.1, 0.2, 0.3],
        payload={"entity_type": "recipe", "entity_id": "recipe-1"},
    )

    method, url, payload, headers = FakeHttpxClient.requests[0]
    assert method == "PUT"
    assert url == "http://qdrant:6333/collections/culina_search/points?wait=true"
    assert headers == {"api-key": "secret"}
    assert payload == {
        "points": [
            {
                "id": str(uuid5(NAMESPACE_URL, "culina-search:recipe:recipe-1")),
                "vector": [0.1, 0.2, 0.3],
                "payload": {
                    "entity_type": "recipe",
                    "entity_id": "recipe-1",
                    "_culina_point_id": "recipe:recipe-1",
                },
            }
        ]
    }


def test_delete_maps_business_point_id_to_qdrant_uuid() -> None:
    _store().delete_point(point_id="recipe:recipe-1")

    method, url, payload, headers = FakeHttpxClient.requests[0]
    assert method == "POST"
    assert url == "http://qdrant:6333/collections/culina_search/points/delete?wait=true"
    assert headers == {"api-key": "secret"}
    assert payload == {"points": [str(uuid5(NAMESPACE_URL, "culina-search:recipe:recipe-1"))]}


def test_search_filters_by_family_and_scope_and_parses_hits() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(
            body={
                "result": [
                    {"score": 0.93, "payload": {"entity_type": "recipe", "entity_id": "recipe-1"}},
                    {"score": 0.88, "payload": {"entity_type": "food", "entity_id": "food-1"}},
                    {"score": 0.77, "payload": {"entity_type": "ingredient", "entity_id": "ingredient-1"}},
                ]
            }
        )
    ]

    hits = _store().search(family_id="family-1", scopes=["recipe", "food"], vector=[0.1, 0.2], limit=5)

    assert [hit.entity_id for hit in hits] == ["recipe-1", "food-1"]
    assert hits[0].semantic_score == 0.93
    method, url, payload, headers = FakeHttpxClient.requests[0]
    assert method == "POST"
    assert url == "http://qdrant:6333/collections/culina_search/points/search"
    assert headers == {"api-key": "secret"}
    assert payload == {
        "vector": [0.1, 0.2],
        "limit": 5,
        "with_payload": True,
        "filter": {
            "must": [
                {"key": "family_id", "match": {"value": "family-1"}},
                {"key": "entity_type", "match": {"any": ["recipe", "food"]}},
            ]
        },
    }


def test_search_can_filter_meal_plan_vectors_by_user() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(
            body={
                "result": [
                    {"score": 0.91, "payload": {"entity_type": "meal_plan", "entity_id": "plan-1"}},
                ]
            }
        )
    ]

    hits = _store().search(family_id="family-1", scopes=["meal_plan"], vector=[0.1, 0.2], limit=5, user_id="user-1")

    assert [hit.entity_id for hit in hits] == ["plan-1"]
    _, _, payload, _ = FakeHttpxClient.requests[0]
    assert payload == {
        "vector": [0.1, 0.2],
        "limit": 5,
        "with_payload": True,
        "filter": {
            "must": [
                {"key": "family_id", "match": {"value": "family-1"}},
                {"key": "entity_type", "match": {"any": ["meal_plan"]}},
                {"key": "user_id", "match": {"value": "user-1"}},
            ]
        },
    }


def test_scroll_points_uses_payload_filter_and_returns_next_offset() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(
            body={
                "result": {
                    "points": [
                        {
                            "id": str(uuid5(NAMESPACE_URL, "culina-search:recipe:recipe-1")),
                            "payload": {
                                "entity_type": "recipe",
                                "entity_id": "recipe-1",
                                "_culina_point_id": "recipe:recipe-1",
                            },
                        },
                        {"id": "", "payload": {"entity_type": "recipe", "entity_id": "missing-id"}},
                    ],
                    "next_page_offset": "next",
                }
            }
        )
    ]

    page = _store().scroll_points(family_id="family-1", scopes=["recipe"], limit=50, offset="current")

    assert [point.point_id for point in page.points] == ["recipe:recipe-1"]
    assert page.next_page_offset == "next"
    method, url, payload, _ = FakeHttpxClient.requests[0]
    assert method == "POST"
    assert url == "http://qdrant:6333/collections/culina_search/points/scroll"
    assert payload == {
        "limit": 50,
        "with_payload": True,
        "with_vector": False,
        "filter": {
            "must": [
                {"key": "family_id", "match": {"value": "family-1"}},
                {"key": "entity_type", "match": {"any": ["recipe"]}},
            ]
        },
        "offset": "current",
    }
