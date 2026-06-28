from __future__ import annotations

import os
from uuid import uuid4

import httpx

from app.services.search.vector_store import QdrantVectorStore


def main() -> None:
    url = os.getenv("QDRANT_URL", "http://127.0.0.1:6333")
    api_key = os.getenv("QDRANT_API_KEY", "")
    base_collection = os.getenv("QDRANT_COLLECTION", "culina_search")
    collection = f"{base_collection}_smoke_{uuid4().hex[:8]}"
    store = QdrantVectorStore(url=url, api_key=api_key, collection=collection, timeout_seconds=10)
    headers = {"api-key": api_key} if api_key else {}
    try:
        store.ensure_collection(vector_size=3)
        store.upsert_point(
            point_id="recipe:smoke-recipe",
            vector=[0.1, 0.2, 0.3],
            payload={
                "family_id": "family-smoke",
                "entity_type": "recipe",
                "entity_id": "smoke-recipe",
                "embedding_model": "smoke",
                "embedding_dimensions": 3,
                "content_hash": "hash-smoke",
                "document_builder_version": "v1",
            },
        )
        store.upsert_point(
            point_id="food:other-family",
            vector=[0.1, 0.2, 0.3],
            payload={
                "family_id": "family-other",
                "entity_type": "food",
                "entity_id": "other-family",
                "embedding_model": "smoke",
                "embedding_dimensions": 3,
                "content_hash": "hash-other",
                "document_builder_version": "v1",
            },
        )
        hits = store.search(
            family_id="family-smoke",
            scopes=["recipe"],
            vector=[0.1, 0.2, 0.3],
            limit=5,
        )
        if [hit.entity_id for hit in hits] != ["smoke-recipe"]:
            raise RuntimeError(f"unexpected search hits: {hits}")
        page = store.scroll_points(family_id="family-smoke", scopes=["recipe"], limit=10)
        if [point.point_id for point in page.points] != ["recipe:smoke-recipe"]:
            raise RuntimeError(f"unexpected scroll points: {page.points}")
        store.delete_point(point_id="recipe:smoke-recipe")
        deleted_hits = store.search(
            family_id="family-smoke",
            scopes=["recipe"],
            vector=[0.1, 0.2, 0.3],
            limit=5,
        )
        if deleted_hits:
            raise RuntimeError(f"deleted point is still searchable: {deleted_hits}")
    finally:
        try:
            with httpx.Client(timeout=10) as client:
                response = client.delete(f"{url.rstrip('/')}/collections/{collection}", headers=headers)
                if response.status_code not in {200, 202, 404}:
                    response.raise_for_status()
        except httpx.HTTPError:
            pass
    print(f"Qdrant search smoke passed: collection={collection}")


if __name__ == "__main__":
    main()
