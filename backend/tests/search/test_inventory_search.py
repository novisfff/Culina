from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.core.enums import InventoryStatus
from app.models.domain import InventoryItem
from app.services.search.hybrid import HybridSearchResponse, HybridSearchResult
from tests.recipes._support import RecipeApiTestCase


@dataclass
class _FakeHybridSearch:
    calls: list[dict[str, object]]

    def __call__(self, db, *, family_id: str, query: str, scopes: list[str], limit: int, offset: int):
        del db, limit, offset
        self.calls.append({"family_id": family_id, "query": query, "scopes": scopes})
        return HybridSearchResponse(
            items=[
                HybridSearchResult(
                    entity_type="ingredient",
                    entity_id="ingredient-tomato",
                    score=0.9,
                    semantic_score=0.9,
                    match_reason=["语意接近：西红柿"],
                )
            ],
            total=1,
            query=query,
            degraded=False,
        )


class InventorySearchTestCase(RecipeApiTestCase):
    def test_inventory_query_uses_hybrid_ingredient_search(self) -> None:
        with self.SessionLocal() as db:
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-tomato",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 1),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-egg",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("6"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 1),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        from app.api import inventory as inventory_api

        fake_search = _FakeHybridSearch(calls=[])
        original_hybrid_search = inventory_api.hybrid_search
        inventory_api.hybrid_search = fake_search
        try:
            response = self.client.get("/api/inventory?q=%E8%A5%BF%E7%BA%A2%E6%9F%BF")
        finally:
            inventory_api.hybrid_search = original_hybrid_search

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in response.json()], ["inventory-tomato"])
        self.assertEqual(fake_search.calls, [{"family_id": self.family.id, "query": "西红柿", "scopes": ["ingredient"]}])
