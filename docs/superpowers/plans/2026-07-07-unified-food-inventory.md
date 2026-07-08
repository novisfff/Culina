# Unified Food Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ready-made and instant food stock visible and actionable in the inventory workspace and AI inventory queries while keeping food profiles owned by the food domain and ingredient stock owned by the ingredient inventory domain.

**Architecture:** Keep `Ingredient`/`InventoryItem` and `Food` as separate domain records. Add a read-only unified inventory projection that combines ingredient batches and ready-like food stock into one response, then add food-stock write helpers that update the existing `Food.stock_quantity`, `Food.stock_unit`, and `Food.expiry_date` fields. The frontend consumes the projection for inventory views, while food creation/editing remains in the food workspace.

**Tech Stack:** FastAPI, SQLAlchemy 2, Pydantic, MySQL, pytest, React 18, TypeScript, Vite, React Query, Vitest.

## Global Constraints

- Ready-made and instant stock stays attached to `Food`; do not create fake `Ingredient` records for packaged meals, yogurt, milk, frozen dumplings, or similar directly edible foods.
- Recipe readiness, recipe cook deduction, recipe ingredient resolution, and shopping-list ingredient binding must continue to use real family-owned `Ingredient` IDs only.
- Phase one must not add a new database table or migration; use the existing `Food.stock_quantity`, `Food.stock_unit`, and `Food.expiry_date` fields for food stock.
- Unified inventory query responses must always be scoped to the current authenticated membership's `family_id`.
- Food stock operations must maintain `Food.updated_by`, log activity, enqueue food search indexing, and run in the same transaction as the API action.
- Frontend UI text must be Simplified Chinese, mobile-first, warm family-kitchen style, and must not become a dense admin table.
- React Query keys must come from `frontend/src/api/queryKeys.ts`; mutation invalidation must be centralized in `frontend/src/api/cacheInvalidation.ts`.
- AI inventory queries may read food stock; AI food-stock writes must use the existing `food_profile` draft approval path rather than exposing direct write tools to the model.
- All final verification commands actually run during implementation must be reported in the final implementation handoff.

---

## File Structure

Create these backend files:

- `backend/app/schemas/inventory_overview.py`: Pydantic response contract for the unified inventory projection.
- `backend/app/services/inventory_overview.py`: Pure read service that builds ingredient-stock and food-stock projection rows.
- `backend/app/services/food_stock.py`: Food stock write helpers used by foods API and quick meal logging.
- `backend/tests/inventory/test_inventory_overview.py`: API tests for unified inventory reads.
- `backend/tests/recipes/test_food_stock_operations.py`: API/service tests for ready-like food stock writes and quick meal deduction.

Modify these backend files:

- `backend/app/api/inventory.py`: Add `GET /api/inventory/overview`.
- `backend/app/api/foods.py`: Add food stock operation endpoints under `/api/foods/{food_id}/stock/*`.
- `backend/app/api/meal_logs.py`: Optionally deduct ready-like food stock during quick meal logging.
- `backend/app/schemas/foods.py`: Add food stock operation request/response schemas.
- `backend/app/schemas/meal_logs.py`: Add quick-add stock deduction fields.
- `backend/app/ai/tools/catalog/inventory.py`: Include food stock in AI inventory read outputs.
- `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`: Clarify that inventory queries include ready-made and instant food stock.
- `backend/app/ai/skills/catalog/food-profile/SKILL.md`: Clarify that food stock writes for ready-made and instant foods are food profile updates.
- `backend/tests/ai_infra/test_inventory_operations.py`: Cover AI inventory summary including food stock.

Create these frontend files:

- `frontend/src/components/ingredients/inventoryOverviewModel.ts`: Pure helpers for unified inventory filtering, grouping, status, and presentation.
- `frontend/src/components/ingredients/inventoryOverviewModel.test.ts`: Vitest coverage for the helpers.

Modify these frontend files:

- `frontend/src/api/types.ts`: Add unified inventory and food stock payload/response types.
- `frontend/src/api/ingredientsApi.ts`: Add `getInventoryOverview()`.
- `frontend/src/api/foodsApi.ts`: Add food stock operation API calls and quick meal stock fields.
- `frontend/src/api/queryKeys.ts`: Add `inventoryOverview()` key.
- `frontend/src/api/cacheInvalidation.ts`: Invalidate unified overview after inventory, food, and meal-log stock changes.
- `frontend/src/components/ingredients/useIngredientWorkspaceState.ts`: Add inventory source filter state.
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`: Query overview data and pass it into desktop/mobile inventory surfaces.
- `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`: Add source filter and render food-stock cards in the inventory panel.
- `frontend/src/components/ingredients/IngredientMobileView.tsx`: Include ready-like food stock in mobile inventory summary and priority cards.
- `frontend/src/components/foods/FoodQuickMealDialog.tsx`: Show stock deduction controls for ready-like foods.
- `frontend/src/components/foods/FoodWorkspace.tsx`: Pass stock deduction data into quick meal payload.
- `frontend/src/components/foods/FoodWorkspace.test.ts`: Cover quick meal stock deduction defaults.
- `frontend/src/styles/04-ingredients-workspace.css`: Add `.ingredients-unified-inventory-*` styles.
- `frontend/src/styles/06-food-workspace.css`: Add quick meal stock deduction styles.

No new third-party dependencies are required.

---

### Task 1: Backend Unified Inventory Overview Read Model

**Files:**
- Create: `backend/app/schemas/inventory_overview.py`
- Create: `backend/app/services/inventory_overview.py`
- Modify: `backend/app/api/inventory.py`
- Test: `backend/tests/inventory/test_inventory_overview.py`

**Interfaces:**
- Consumes: existing `Ingredient`, `InventoryItem`, `Food`, `remaining_quantity()`, `tracks_quantity()`, `get_media_assets_for_entities()`.
- Produces: `InventoryOverviewItemOut`, `InventoryOverviewOut`, and `build_inventory_overview(db, family_id, scope, query, today) -> dict[str, Any]`.

- [ ] **Step 1: Write failing backend API tests**

Create `backend/tests/inventory/test_inventory_overview.py` with this content:

```python
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import InventoryStatus
from app.models.domain import Food, Ingredient, InventoryItem


def test_inventory_overview_returns_ingredient_and_ready_food_stock(auth_client, db: Session, family, user):
    tomato = Ingredient(
        id="ingredient-overview-tomato",
        family_id=family.id,
        name="番茄",
        category="蔬菜",
        default_unit="个",
        unit_conversions=[],
        default_storage="冷藏",
        default_expiry_mode="none",
        notes="",
        created_by=user.id,
        updated_by=user.id,
    )
    tomato_batch = InventoryItem(
        id="inventory-overview-tomato",
        family_id=family.id,
        ingredient_id=tomato.id,
        quantity=Decimal("3"),
        consumed_quantity=Decimal("1"),
        disposed_quantity=Decimal("0"),
        unit="个",
        entered_quantity=Decimal("3"),
        entered_unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        expiry_date=date(2026, 7, 10),
        storage_location="冷藏",
        notes="",
        low_stock_threshold=Decimal("1"),
        created_by=user.id,
        updated_by=user.id,
    )
    yogurt = Food(
        id="food-overview-yogurt",
        family_id=family.id,
        name="蓝莓酸奶",
        type="readyMade",
        category="饮品",
        flavor_tags=[],
        scene_tags=["早餐"],
        suitable_meal_types=["breakfast"],
        source_name="超市",
        purchase_source="盒马",
        scene="",
        notes="",
        routine_note="早餐备用",
        stock_quantity=Decimal("2"),
        stock_unit="盒",
        expiry_date=date(2026, 7, 8),
        favorite=False,
        created_by=user.id,
        updated_by=user.id,
    )
    takeout = Food(
        id="food-overview-takeout",
        family_id=family.id,
        name="常点牛肉饭",
        type="takeout",
        category="外卖",
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=["lunch"],
        source_name="楼下店",
        purchase_source="美团",
        scene="",
        notes="",
        routine_note="",
        stock_quantity=Decimal("3"),
        stock_unit="份",
        expiry_date=date(2026, 7, 8),
        favorite=False,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add_all([tomato, tomato_batch, yogurt, takeout])
    db.commit()

    response = auth_client.get("/api/inventory/overview?scope=all")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["total_count"] == 2
    assert payload["summary"]["ingredient_count"] == 1
    assert payload["summary"]["food_count"] == 1
    assert [item["source_type"] for item in payload["items"]] == ["food", "ingredient"]
    assert payload["items"][0]["source_id"] == "food-overview-yogurt"
    assert payload["items"][0]["title"] == "蓝莓酸奶"
    assert payload["items"][0]["quantity_label"] == "2盒"
    assert payload["items"][0]["primary_action"] == "record_meal"
    assert payload["items"][1]["source_id"] == "ingredient-overview-tomato"
    assert payload["items"][1]["quantity_label"] == "2个"


def test_inventory_overview_filters_scope_and_query(auth_client, db: Session, family, user):
    yogurt = Food(
        id="food-overview-query-yogurt",
        family_id=family.id,
        name="蓝莓酸奶",
        type="instant",
        category="速食",
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=["breakfast"],
        source_name="便利店",
        purchase_source="便利店",
        scene="",
        notes="",
        routine_note="",
        stock_quantity=Decimal("1"),
        stock_unit="盒",
        expiry_date=date.today() + timedelta(days=3),
        favorite=False,
        created_by=user.id,
        updated_by=user.id,
    )
    freezer = Food(
        id="food-overview-query-dumpling",
        family_id=family.id,
        name="速冻饺子",
        type="instant",
        category="速冻食品",
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=["dinner"],
        source_name="超市",
        purchase_source="超市",
        scene="",
        notes="",
        routine_note="",
        stock_quantity=Decimal("2"),
        stock_unit="袋",
        expiry_date=date.today() + timedelta(days=20),
        favorite=False,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add_all([yogurt, freezer])
    db.commit()

    response = auth_client.get("/api/inventory/overview?scope=food&q=酸奶")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["total_count"] == 1
    assert payload["items"][0]["source_type"] == "food"
    assert payload["items"][0]["source_id"] == "food-overview-query-yogurt"
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/inventory/test_inventory_overview.py -q
```

Expected: fail with `404 Not Found` for `/api/inventory/overview`.

- [ ] **Step 3: Add response schemas**

Create `backend/app/schemas/inventory_overview.py`:

```python
from __future__ import annotations

from datetime import date as date_type
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import IngredientQuantityTrackingMode, InventoryStatus
from app.schemas.media import MediaAssetOut


InventoryOverviewScope = Literal["all", "ingredient", "food"]
InventoryOverviewSourceType = Literal["ingredient", "food"]
InventoryOverviewTone = Literal["stable", "warning", "danger", "empty"]
InventoryOverviewPrimaryAction = Literal[
    "restock",
    "consume",
    "dispose",
    "record_meal",
    "edit_food_stock",
]


class InventoryOverviewItemOut(BaseModel):
    id: str
    source_type: InventoryOverviewSourceType
    source_id: str
    inventory_item_id: str | None = None
    title: str
    category: str
    image: MediaAssetOut | None = None
    quantity: float | None = None
    unit: str
    quantity_label: str
    quantity_tracking_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    status: InventoryStatus | None = None
    tone: InventoryOverviewTone
    expiry_date: date_type | None = None
    days_until_expiry: int | None = None
    storage_location: str
    purchase_source: str | None = None
    updated_at: str
    primary_action: InventoryOverviewPrimaryAction
    search_text: str


class InventoryOverviewSummaryOut(BaseModel):
    total_count: int = Field(ge=0)
    ingredient_count: int = Field(ge=0)
    food_count: int = Field(ge=0)
    alert_count: int = Field(ge=0)
    expiring_count: int = Field(ge=0)
    empty_count: int = Field(ge=0)


class InventoryOverviewOut(BaseModel):
    scope: InventoryOverviewScope
    query: str
    summary: InventoryOverviewSummaryOut
    items: list[InventoryOverviewItemOut] = Field(default_factory=list)
```

- [ ] **Step 4: Add projection service**

Create `backend/app/services/inventory_overview.py`:

```python
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import FoodType, IngredientQuantityTrackingMode
from app.models.domain import Food, Ingredient, InventoryItem
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.inventory_usage import remaining_quantity, tracks_quantity
from app.services.serializers import serialize_media

InventoryOverviewScope = Literal["all", "ingredient", "food"]

READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


def is_ready_like_food(food: Food) -> bool:
    food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
    return food_type in READY_LIKE_FOOD_TYPES


def _format_quantity(value: Decimal | None, unit: str, fallback: str) -> str:
    if value is None:
        return fallback
    normalized = f"{float(value):g}"
    return f"{normalized}{unit or '份'}"


def _days_until(value: date | None, today: date) -> int | None:
    return None if value is None else (value - today).days


def _tone_for_stock(quantity: Decimal | None, expiry_date: date | None, today: date) -> str:
    days = _days_until(expiry_date, today)
    if quantity is not None and quantity <= 0:
        return "empty"
    if days is not None and days < 0:
        return "danger"
    if days is not None and days <= 7:
        return "warning"
    return "stable"


def _serialize_first_media(media_map: dict[tuple[str, str], list[Any]], entity_type: str, entity_id: str) -> dict | None:
    media = media_map.get((entity_type, entity_id), [])
    return serialize_media(media[0]) if media else None


def _matches_query(row: dict[str, Any], query: str) -> bool:
    if not query:
        return True
    return query in row["search_text"]


def _ingredient_rows(
    db: Session,
    *,
    family_id: str,
    today: date,
    query: str,
) -> list[dict[str, Any]]:
    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id)
            .options(selectinload(InventoryItem.ingredient))
            .order_by(InventoryItem.updated_at.desc(), InventoryItem.id)
        )
    )
    ingredient_ids = [item.ingredient_id for item in items]
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="ingredient",
            entity_ids=ingredient_ids,
        )
    )
    rows: list[dict[str, Any]] = []
    for item in items:
        ingredient = item.ingredient
        if ingredient is None:
            continue
        tracks = tracks_quantity(ingredient)
        remaining = remaining_quantity(item)
        has_presence = item.quantity - getattr(item, "disposed_quantity", Decimal("0")) > 0
        if tracks and remaining <= 0:
            continue
        if not tracks and not has_presence:
            continue
        days = _days_until(item.expiry_date, today)
        tone = _tone_for_stock(remaining if tracks else Decimal("1"), item.expiry_date, today)
        quantity_label = _format_quantity(remaining, item.unit, "已有") if tracks else "已有"
        row = {
            "id": f"ingredient:{item.id}",
            "source_type": "ingredient",
            "source_id": ingredient.id,
            "inventory_item_id": item.id,
            "title": ingredient.name,
            "category": ingredient.category,
            "image": _serialize_first_media(media_map, "ingredient", ingredient.id),
            "quantity": float(remaining) if tracks else None,
            "unit": item.unit,
            "quantity_label": quantity_label,
            "quantity_tracking_mode": (
                ingredient.quantity_tracking_mode.value
                if hasattr(ingredient.quantity_tracking_mode, "value")
                else ingredient.quantity_tracking_mode
            ),
            "status": item.status.value if hasattr(item.status, "value") else item.status,
            "tone": tone,
            "expiry_date": item.expiry_date,
            "days_until_expiry": days,
            "storage_location": item.storage_location or ingredient.default_storage or "常温",
            "purchase_source": None,
            "updated_at": item.updated_at.isoformat(),
            "primary_action": "dispose" if tone == "danger" else "consume" if tracks else "restock",
            "search_text": " ".join(
                [
                    ingredient.name,
                    ingredient.category,
                    ingredient.notes,
                    item.storage_location,
                    item.notes,
                ]
            ),
        }
        if _matches_query(row, query):
            rows.append(row)
    return rows


def _food_rows(
    db: Session,
    *,
    family_id: str,
    today: date,
    query: str,
) -> list[dict[str, Any]]:
    foods = list(
        db.scalars(
            select(Food)
            .where(Food.family_id == family_id, Food.type.in_(READY_LIKE_FOOD_TYPES))
            .order_by(Food.updated_at.desc(), Food.id)
        )
    )
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="food",
            entity_ids=[food.id for food in foods],
        )
    )
    rows: list[dict[str, Any]] = []
    for food in foods:
        if not is_ready_like_food(food):
            continue
        quantity = food.stock_quantity
        if quantity is None or quantity <= 0:
            continue
        days = _days_until(food.expiry_date, today)
        tone = _tone_for_stock(quantity, food.expiry_date, today)
        row = {
            "id": f"food:{food.id}",
            "source_type": "food",
            "source_id": food.id,
            "inventory_item_id": None,
            "title": food.name,
            "category": food.category,
            "image": _serialize_first_media(media_map, "food", food.id),
            "quantity": float(quantity),
            "unit": food.stock_unit or "份",
            "quantity_label": _format_quantity(quantity, food.stock_unit or "份", "未记录"),
            "quantity_tracking_mode": IngredientQuantityTrackingMode.TRACK_QUANTITY.value,
            "status": None,
            "tone": tone,
            "expiry_date": food.expiry_date,
            "days_until_expiry": days,
            "storage_location": "食物库",
            "purchase_source": food.purchase_source or food.source_name or None,
            "updated_at": food.updated_at.isoformat(),
            "primary_action": "edit_food_stock" if tone == "danger" else "record_meal",
            "search_text": " ".join(
                [
                    food.name,
                    food.category,
                    food.source_name,
                    food.purchase_source,
                    food.notes,
                    food.routine_note,
                    " ".join(food.scene_tags or []),
                ]
            ),
        }
        if _matches_query(row, query):
            rows.append(row)
    return rows


def build_inventory_overview(
    db: Session,
    *,
    family_id: str,
    scope: InventoryOverviewScope,
    query: str,
    today: date,
) -> dict[str, Any]:
    normalized_query = query.strip()
    rows: list[dict[str, Any]] = []
    if scope in {"all", "ingredient"}:
        rows.extend(_ingredient_rows(db, family_id=family_id, today=today, query=normalized_query))
    if scope in {"all", "food"}:
        rows.extend(_food_rows(db, family_id=family_id, today=today, query=normalized_query))
    rows.sort(key=lambda row: (row["tone"] != "danger", row["tone"] != "warning", row["updated_at"]), reverse=False)
    summary = {
        "total_count": len(rows),
        "ingredient_count": sum(1 for row in rows if row["source_type"] == "ingredient"),
        "food_count": sum(1 for row in rows if row["source_type"] == "food"),
        "alert_count": sum(1 for row in rows if row["tone"] in {"warning", "danger"}),
        "expiring_count": sum(1 for row in rows if row["days_until_expiry"] is not None and row["days_until_expiry"] <= 7),
        "empty_count": sum(1 for row in rows if row["tone"] == "empty"),
    }
    return {"scope": scope, "query": normalized_query, "summary": summary, "items": rows}
```

- [ ] **Step 5: Add the API route**

Modify `backend/app/api/inventory.py`:

```python
from app.schemas.inventory_overview import InventoryOverviewOut, InventoryOverviewScope
from app.services.inventory_overview import build_inventory_overview
```

Add this route before `@router.get("/api/inventory", ...)`:

```python
@router.get("/api/inventory/overview", response_model=InventoryOverviewOut)
def inventory_overview(
    scope: InventoryOverviewScope = Query(default="all"),
    q: str = Query(default="", max_length=100),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    return build_inventory_overview(
        db,
        family_id=membership.family_id,
        scope=scope,
        query=q,
        today=today_for_family(membership.family_id),
    )
```

- [ ] **Step 6: Run backend overview tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/inventory/test_inventory_overview.py -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas/inventory_overview.py backend/app/services/inventory_overview.py backend/app/api/inventory.py backend/tests/inventory/test_inventory_overview.py
git commit -m "feat: expose unified inventory overview"
```

---

### Task 2: Food Stock Operations And Quick Meal Deduction

**Files:**
- Create: `backend/app/services/food_stock.py`
- Modify: `backend/app/schemas/foods.py`
- Modify: `backend/app/api/foods.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/app/api/meal_logs.py`
- Test: `backend/tests/recipes/test_food_stock_operations.py`

**Interfaces:**
- Consumes: `is_ready_like_food(food: Food) -> bool` from Task 1.
- Produces:
  - `apply_food_stock_restock(db, family_id, user_id, food, quantity, unit, expiry_date, purchase_source, note) -> Food`
  - `apply_food_stock_consume(db, family_id, user_id, food, quantity, unit, note) -> Food`
  - `apply_food_stock_dispose(db, family_id, user_id, food, quantity, unit, reason) -> Food`
  - API endpoints `POST /api/foods/{food_id}/stock/restock`, `consume`, `dispose`.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/recipes/test_food_stock_operations.py`:

```python
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import ActivityLog, Food


def _ready_food(family, user, **overrides):
    values = {
        "id": "food-stock-yogurt",
        "family_id": family.id,
        "name": "蓝莓酸奶",
        "type": "readyMade",
        "category": "饮品",
        "flavor_tags": [],
        "scene_tags": [],
        "suitable_meal_types": ["breakfast"],
        "source_name": "超市",
        "purchase_source": "盒马",
        "scene": "",
        "notes": "",
        "routine_note": "",
        "stock_quantity": Decimal("2"),
        "stock_unit": "盒",
        "expiry_date": date(2026, 7, 10),
        "favorite": False,
        "created_by": user.id,
        "updated_by": user.id,
    }
    values.update(overrides)
    return Food(**values)


def test_food_stock_restock_consume_and_dispose(auth_client, db: Session, family, user):
    food = _ready_food(family, user)
    db.add(food)
    db.commit()

    restock = auth_client.post(
        "/api/foods/food-stock-yogurt/stock/restock",
        json={"quantity": 3, "unit": "盒", "expiry_date": "2026-07-20", "purchase_source": "山姆", "note": "周末补货"},
    )
    assert restock.status_code == 200, restock.text
    assert restock.json()["stock_quantity"] == 5
    assert restock.json()["stock_unit"] == "盒"
    assert restock.json()["expiry_date"] == "2026-07-20"
    assert restock.json()["purchase_source"] == "山姆"

    consume = auth_client.post(
        "/api/foods/food-stock-yogurt/stock/consume",
        json={"quantity": 1, "unit": "盒", "note": "早餐吃掉"},
    )
    assert consume.status_code == 200, consume.text
    assert consume.json()["stock_quantity"] == 4

    dispose = auth_client.post(
        "/api/foods/food-stock-yogurt/stock/dispose",
        json={"quantity": 2, "unit": "盒", "reason": "包装破损"},
    )
    assert dispose.status_code == 200, dispose.text
    assert dispose.json()["stock_quantity"] == 2

    logs = list(db.scalars(select(ActivityLog).where(ActivityLog.entity_type == "Food", ActivityLog.entity_id == "food-stock-yogurt")))
    assert [log.action for log in logs] == ["update", "update", "update"]


def test_food_stock_rejects_outside_food_and_overconsume(auth_client, db: Session, family, user):
    takeout = _ready_food(
        family,
        user,
        id="food-stock-takeout",
        name="牛肉饭",
        type="takeout",
        stock_quantity=Decimal("2"),
        stock_unit="份",
    )
    yogurt = _ready_food(family, user, id="food-stock-low", stock_quantity=Decimal("1"))
    db.add_all([takeout, yogurt])
    db.commit()

    takeout_response = auth_client.post(
        "/api/foods/food-stock-takeout/stock/consume",
        json={"quantity": 1, "unit": "份"},
    )
    assert takeout_response.status_code == 400
    assert takeout_response.json()["detail"] == "只有成品、速食和包装食品支持食物库存操作"

    overconsume = auth_client.post(
        "/api/foods/food-stock-low/stock/consume",
        json={"quantity": 2, "unit": "盒"},
    )
    assert overconsume.status_code == 400
    assert overconsume.json()["detail"] == "当前最多只能处理 1盒"


def test_quick_add_ready_food_can_deduct_stock_in_same_request(auth_client, db: Session, family, user):
    food = _ready_food(family, user, id="food-stock-quick", stock_quantity=Decimal("2"))
    db.add(food)
    db.commit()

    response = auth_client.post(
        "/api/meal-logs/quick-add",
        json={
            "food_id": "food-stock-quick",
            "date": "2026-07-07",
            "meal_type": "breakfast",
            "servings": 1,
            "note": "",
            "deduct_food_stock": True,
            "stock_quantity": 1,
        },
    )

    assert response.status_code == 201, response.text
    db.refresh(food)
    assert food.stock_quantity == Decimal("1.00")
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/recipes/test_food_stock_operations.py -q
```

Expected: fail with `404 Not Found` for food stock endpoints and rejected extra quick-add fields.

- [ ] **Step 3: Add schemas**

Modify `backend/app/schemas/foods.py`:

```python
class FoodStockChangeRequest(BaseModel):
    quantity: float = Field(gt=0)
    unit: str | None = Field(default=None, max_length=32)
    expiry_date: date_type | None = None
    purchase_source: str | None = Field(default=None, max_length=120)
    note: str = Field(default="", max_length=255)
    reason: str = Field(default="", max_length=255)


class FoodStockChangeOut(FoodOut):
    pass
```

Modify `backend/app/schemas/meal_logs.py` in `QuickAddMealLogRequest`:

```python
    deduct_food_stock: bool = False
    stock_quantity: float | None = Field(default=None, gt=0)
    stock_unit: str | None = Field(default=None, max_length=32)
```

- [ ] **Step 4: Add the food stock service**

Create `backend/app/services/food_stock.py`:

```python
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction
from app.models.domain import Food
from app.services.activity import log_activity
from app.services.inventory_overview import is_ready_like_food
from app.services.search.jobs import enqueue_search_index_job


def _normalize_unit(unit: str | None, fallback: str) -> str:
    normalized = (unit or fallback or "份").strip()
    if not normalized:
        raise ValueError("单位不能为空")
    return normalized


def _require_food_stock_managed(food: Food) -> None:
    if not is_ready_like_food(food):
        raise ValueError("只有成品、速食和包装食品支持食物库存操作")


def _current_quantity(food: Food) -> Decimal:
    return Decimal(str(food.stock_quantity or 0))


def _format_quantity(value: Decimal, unit: str) -> str:
    return f"{float(value):g}{unit}"


def _touch_food_stock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    summary: str,
) -> Food:
    food.updated_by = user_id
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=food.id,
        summary=summary,
    )
    enqueue_search_index_job(
        db,
        family_id=family_id,
        user_id=user_id,
        entity_type="food",
        entity_id=food.id,
        target_name=food.name,
    )
    db.flush()
    return food


def apply_food_stock_restock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    expiry_date: date | None,
    purchase_source: str | None,
    note: str = "",
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit and _current_quantity(food) > 0:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，请先清空或使用相同单位")
    food.stock_unit = normalized_unit
    food.stock_quantity = _current_quantity(food) + quantity
    if expiry_date is not None:
        food.expiry_date = expiry_date
    if purchase_source is not None:
        food.purchase_source = purchase_source.strip()
    detail = f"补充食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(db, family_id=family_id, user_id=user_id, food=food, summary=detail)


def apply_food_stock_consume(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    note: str = "",
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 扣减")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = current - quantity
    detail = f"记录食用 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(db, family_id=family_id, user_id=user_id, food=food, summary=detail)


def apply_food_stock_dispose(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    reason: str,
) -> Food:
    _require_food_stock_managed(food)
    if not reason.strip():
        raise ValueError("请填写处理原因")
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 处理")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = current - quantity
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=f"处理食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}：{reason.strip()}",
    )
```

- [ ] **Step 5: Add food stock API endpoints**

Modify imports in `backend/app/api/foods.py`:

```python
from decimal import Decimal
from app.schemas.foods import CreateFoodRequest, FoodOut, FoodRecommendationsOut, FoodStockChangeOut, FoodStockChangeRequest, UpdateFoodFavoriteRequest, UpdateFoodRequest
from app.services.food_stock import apply_food_stock_consume, apply_food_stock_dispose, apply_food_stock_restock
```

Add helper and routes after `update_food_favorite()`:

```python
def _require_food_for_stock(db: Session, *, family_id: str, food_id: str) -> Food:
    food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id).with_for_update())
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    return food


@router.post("/api/foods/{food_id}/stock/restock", response_model=FoodStockChangeOut)
def restock_food_stock(
    food_id: str,
    payload: FoodStockChangeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = _require_food_for_stock(db, family_id=membership.family_id, food_id=food_id)
    try:
        apply_food_stock_restock(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            food=food,
            quantity=Decimal(str(payload.quantity)),
            unit=payload.unit,
            expiry_date=payload.expiry_date,
            purchase_source=payload.purchase_source,
            note=payload.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)


@router.post("/api/foods/{food_id}/stock/consume", response_model=FoodStockChangeOut)
def consume_food_stock(
    food_id: str,
    payload: FoodStockChangeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = _require_food_for_stock(db, family_id=membership.family_id, food_id=food_id)
    try:
        apply_food_stock_consume(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            food=food,
            quantity=Decimal(str(payload.quantity)),
            unit=payload.unit,
            note=payload.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)


@router.post("/api/foods/{food_id}/stock/dispose", response_model=FoodStockChangeOut)
def dispose_food_stock(
    food_id: str,
    payload: FoodStockChangeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = _require_food_for_stock(db, family_id=membership.family_id, food_id=food_id)
    try:
        apply_food_stock_dispose(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            food=food,
            quantity=Decimal(str(payload.quantity)),
            unit=payload.unit,
            reason=payload.reason,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)
```

- [ ] **Step 6: Deduct food stock during quick meal logging**

Modify imports in `backend/app/api/meal_logs.py`:

```python
from decimal import Decimal
from app.services.food_stock import apply_food_stock_consume
```

Inside `quick_add_meal_log()`, after the `Food` has been loaded and before `log_activity(...)`, add:

```python
    if payload.deduct_food_stock:
        try:
            apply_food_stock_consume(
                db,
                family_id=membership.family_id,
                user_id=user.id,
                food=food,
                quantity=Decimal(str(payload.stock_quantity or payload.servings)),
                unit=payload.stock_unit or food.stock_unit or "份",
                note="随餐食记录扣减",
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
```

- [ ] **Step 7: Run food stock tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/recipes/test_food_stock_operations.py -q
```

Expected: pass.

- [ ] **Step 8: Run focused backend regression tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/inventory/test_inventory_api.py backend/tests/recipes/test_food_workspace.py backend/tests/recipes/test_food_queries.py -q
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/food_stock.py backend/app/schemas/foods.py backend/app/api/foods.py backend/app/schemas/meal_logs.py backend/app/api/meal_logs.py backend/tests/recipes/test_food_stock_operations.py
git commit -m "feat: manage ready food stock"
```

---

### Task 3: Frontend API Contract And Inventory Overview Model

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/ingredientsApi.ts`
- Modify: `frontend/src/api/foodsApi.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Create: `frontend/src/components/ingredients/inventoryOverviewModel.ts`
- Test: `frontend/src/components/ingredients/inventoryOverviewModel.test.ts`

**Interfaces:**
- Consumes: backend `GET /api/inventory/overview` and food stock endpoints from Tasks 1 and 2.
- Produces: `InventoryOverview`, `InventoryOverviewItem`, `buildUnifiedInventoryGroups()`, `filterUnifiedInventoryItems()`, `buildUnifiedInventorySummary()`.

- [ ] **Step 1: Write failing frontend model tests**

Create `frontend/src/components/ingredients/inventoryOverviewModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InventoryOverviewItem } from '../../api/types';
import {
  buildUnifiedInventoryGroups,
  buildUnifiedInventorySummary,
  filterUnifiedInventoryItems,
  getUnifiedInventoryActionLabel,
} from './inventoryOverviewModel';

const ingredientItem: InventoryOverviewItem = {
  id: 'ingredient:inventory-tomato',
  source_type: 'ingredient',
  source_id: 'ingredient-tomato',
  inventory_item_id: 'inventory-tomato',
  title: '番茄',
  category: '蔬菜',
  image: null,
  quantity: 2,
  unit: '个',
  quantity_label: '2个',
  quantity_tracking_mode: 'track_quantity',
  status: 'fresh',
  tone: 'stable',
  expiry_date: '2026-07-10',
  days_until_expiry: 3,
  storage_location: '冷藏',
  purchase_source: null,
  updated_at: '2026-07-06T12:00:00Z',
  primary_action: 'consume',
  search_text: '番茄 蔬菜 冷藏',
};

const foodItem: InventoryOverviewItem = {
  id: 'food:food-yogurt',
  source_type: 'food',
  source_id: 'food-yogurt',
  inventory_item_id: null,
  title: '蓝莓酸奶',
  category: '饮品',
  image: null,
  quantity: 2,
  unit: '盒',
  quantity_label: '2盒',
  quantity_tracking_mode: 'track_quantity',
  status: null,
  tone: 'warning',
  expiry_date: '2026-07-08',
  days_until_expiry: 1,
  storage_location: '食物库',
  purchase_source: '盒马',
  updated_at: '2026-07-07T12:00:00Z',
  primary_action: 'record_meal',
  search_text: '蓝莓酸奶 饮品 盒马 早餐',
};

describe('inventoryOverviewModel', () => {
  it('filters by source type and search text', () => {
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'food', search: '酸奶' })).toEqual([foodItem]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'ingredient', search: '酸奶' })).toEqual([]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', search: '冷藏' })).toEqual([ingredientItem]);
  });

  it('groups items by storage and counts food stock separately', () => {
    const groups = buildUnifiedInventoryGroups([ingredientItem, foodItem]);
    expect(groups.map((group) => group.key)).toEqual(['食物库', '冷藏']);
    expect(groups[0].foodCount).toBe(1);
    expect(groups[1].ingredientCount).toBe(1);
  });

  it('builds summary metrics and action labels', () => {
    expect(buildUnifiedInventorySummary([ingredientItem, foodItem])).toEqual({
      totalCount: 2,
      ingredientCount: 1,
      foodCount: 1,
      alertCount: 1,
    });
    expect(getUnifiedInventoryActionLabel(foodItem)).toBe('记到今天');
    expect(getUnifiedInventoryActionLabel(ingredientItem)).toBe('消费');
  });
});
```

- [ ] **Step 2: Run frontend test and verify it fails**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/inventoryOverviewModel.test.ts
```

Expected: fail because `inventoryOverviewModel.ts` does not exist.

- [ ] **Step 3: Add API types**

Modify `frontend/src/api/types.ts`:

```ts
export type InventoryOverviewScope = 'all' | 'ingredient' | 'food';
export type InventoryOverviewSourceType = 'ingredient' | 'food';
export type InventoryOverviewTone = 'stable' | 'warning' | 'danger' | 'empty';
export type InventoryOverviewPrimaryAction = 'restock' | 'consume' | 'dispose' | 'record_meal' | 'edit_food_stock';

export interface InventoryOverviewItem {
  id: string;
  source_type: InventoryOverviewSourceType;
  source_id: string;
  inventory_item_id?: string | null;
  title: string;
  category: string;
  image?: MediaAsset | null;
  quantity?: number | null;
  unit: string;
  quantity_label: string;
  quantity_tracking_mode: IngredientQuantityTrackingMode;
  status?: InventoryStatus | null;
  tone: InventoryOverviewTone;
  expiry_date?: string | null;
  days_until_expiry?: number | null;
  storage_location: string;
  purchase_source?: string | null;
  updated_at: string;
  primary_action: InventoryOverviewPrimaryAction;
  search_text: string;
}

export interface InventoryOverview {
  scope: InventoryOverviewScope;
  query: string;
  summary: {
    total_count: number;
    ingredient_count: number;
    food_count: number;
    alert_count: number;
    expiring_count: number;
    empty_count: number;
  };
  items: InventoryOverviewItem[];
}

export interface FoodStockChangePayload {
  quantity: number;
  unit?: string | null;
  expiry_date?: string | null;
  purchase_source?: string | null;
  note?: string;
  reason?: string;
}
```

Modify `QuickAddMealLogPayload` in the same file:

```ts
  deduct_food_stock?: boolean;
  stock_quantity?: number | null;
  stock_unit?: string | null;
```

- [ ] **Step 4: Add API calls and cache keys**

Modify `frontend/src/api/ingredientsApi.ts` imports to include `InventoryOverview` and `InventoryOverviewScope`, then add:

```ts
  getInventoryOverview: (params: { scope?: InventoryOverviewScope; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.scope && params.scope !== 'all') search.set('scope', params.scope);
    if (params.q?.trim()) search.set('q', params.q.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<InventoryOverview>(`/api/inventory/overview${suffix}`);
  },
```

Modify `frontend/src/api/foodsApi.ts` imports to include `FoodStockChangePayload`, then add:

```ts
  restockFoodStock: (foodId: string, payload: FoodStockChangePayload) =>
    request<Food>(`/api/foods/${foodId}/stock/restock`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  consumeFoodStock: (foodId: string, payload: FoodStockChangePayload) =>
    request<Food>(`/api/foods/${foodId}/stock/consume`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disposeFoodStock: (foodId: string, payload: FoodStockChangePayload) =>
    request<Food>(`/api/foods/${foodId}/stock/dispose`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
```

Modify `frontend/src/api/queryKeys.ts`:

```ts
  inventoryOverview: (scope = 'all', query = '') => ['inventory', 'overview', scope, query.trim()] as const,
```

Modify `frontend/src/api/cacheInvalidation.ts`:

```ts
export function invalidateAfterInventoryChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.inventory, queryKeys.inventoryOverview(), queryKeys.foodRecommendations, queryKeys.activityLogs]);
}
```

And:

```ts
export function invalidateAfterFoodChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.foods, queryKeys.inventoryOverview(), queryKeys.foodRecommendations, queryKeys.activityLogs]);
}
```

And:

```ts
export function invalidateAfterQuickMealAdded(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.mealLogs, queryKeys.foodPlanRoot, queryKeys.foods, queryKeys.inventoryOverview(), queryKeys.foodRecommendations, queryKeys.activityLogs]);
}
```

- [ ] **Step 5: Add the frontend overview model**

Create `frontend/src/components/ingredients/inventoryOverviewModel.ts`:

```ts
import type { InventoryOverviewItem, InventoryOverviewSourceType } from '../../api/types';

export type UnifiedInventorySourceFilter = 'all' | InventoryOverviewSourceType;

export type UnifiedInventoryFilter = {
  source: UnifiedInventorySourceFilter;
  search: string;
};

export type UnifiedInventoryGroup = {
  key: string;
  label: string;
  items: InventoryOverviewItem[];
  ingredientCount: number;
  foodCount: number;
  alertCount: number;
};

export function filterUnifiedInventoryItems(items: InventoryOverviewItem[], filter: UnifiedInventoryFilter) {
  const search = filter.search.trim();
  return items.filter((item) => {
    const sourceMatches = filter.source === 'all' || item.source_type === filter.source;
    const searchMatches =
      !search ||
      item.title.includes(search) ||
      item.category.includes(search) ||
      item.storage_location.includes(search) ||
      item.search_text.includes(search);
    return sourceMatches && searchMatches;
  });
}

function groupWeight(key: string) {
  if (key === '食物库') return 0;
  if (key === '冷藏') return 1;
  if (key === '冷冻') return 2;
  if (key === '常温') return 3;
  return 4;
}

export function buildUnifiedInventoryGroups(items: InventoryOverviewItem[]): UnifiedInventoryGroup[] {
  const grouped = new Map<string, InventoryOverviewItem[]>();
  for (const item of items) {
    const key = item.storage_location || (item.source_type === 'food' ? '食物库' : '常温');
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()]
    .sort((left, right) => groupWeight(left[0]) - groupWeight(right[0]) || left[0].localeCompare(right[0], 'zh-CN'))
    .map(([key, groupItems]) => ({
      key,
      label: key,
      items: groupItems.slice().sort((left, right) => {
        const toneRank = { danger: 0, warning: 1, empty: 2, stable: 3 } satisfies Record<InventoryOverviewItem['tone'], number>;
        return toneRank[left.tone] - toneRank[right.tone] || right.updated_at.localeCompare(left.updated_at);
      }),
      ingredientCount: groupItems.filter((item) => item.source_type === 'ingredient').length,
      foodCount: groupItems.filter((item) => item.source_type === 'food').length,
      alertCount: groupItems.filter((item) => item.tone === 'warning' || item.tone === 'danger').length,
    }));
}

export function buildUnifiedInventorySummary(items: InventoryOverviewItem[]) {
  return {
    totalCount: items.length,
    ingredientCount: items.filter((item) => item.source_type === 'ingredient').length,
    foodCount: items.filter((item) => item.source_type === 'food').length,
    alertCount: items.filter((item) => item.tone === 'warning' || item.tone === 'danger').length,
  };
}

export function getUnifiedInventorySourceLabel(item: Pick<InventoryOverviewItem, 'source_type'>) {
  return item.source_type === 'food' ? '成品速食' : '食材库存';
}

export function getUnifiedInventoryActionLabel(item: Pick<InventoryOverviewItem, 'primary_action'>) {
  switch (item.primary_action) {
    case 'record_meal':
      return '记到今天';
    case 'edit_food_stock':
      return '更新库存';
    case 'consume':
      return '消费';
    case 'dispose':
      return '处理提醒';
    case 'restock':
      return '补货';
    default:
      return '查看';
  }
}
```

- [ ] **Step 6: Run frontend model tests**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/inventoryOverviewModel.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/ingredientsApi.ts frontend/src/api/foodsApi.ts frontend/src/api/queryKeys.ts frontend/src/api/cacheInvalidation.ts frontend/src/components/ingredients/inventoryOverviewModel.ts frontend/src/components/ingredients/inventoryOverviewModel.test.ts
git commit -m "feat: add unified inventory frontend contract"
```

---

### Task 4: Desktop Inventory Workspace Unified View

**Files:**
- Modify: `frontend/src/components/ingredients/useIngredientWorkspaceState.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/styles/04-ingredients-workspace.css`
- Test: `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts`

**Interfaces:**
- Consumes: `InventoryOverview`, `InventoryOverviewItem`, `filterUnifiedInventoryItems()`, `buildUnifiedInventoryGroups()`, `getUnifiedInventoryActionLabel()`.
- Produces: desktop inventory panel with `全部库存 / 食材库存 / 成品速食` source filter and food-stock cards.

- [ ] **Step 1: Add a failing usage test for the source filter**

Append to `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts`:

```ts
import { readFileSync } from 'node:fs';

it('renders unified inventory source filters and food stock copy', () => {
  const panelsSource = readFileSync('src/components/ingredients/IngredientWorkspacePanels.tsx', 'utf8');
  expect(panelsSource).toContain('全部库存');
  expect(panelsSource).toContain('食材库存');
  expect(panelsSource).toContain('成品速食');
  expect(panelsSource).toContain('getUnifiedInventoryActionLabel');

  const workspaceSource = readFileSync('src/components/ingredients/IngredientWorkspace.tsx', 'utf8');
  expect(workspaceSource).toContain('api.getInventoryOverview');
  expect(workspaceSource).toContain('queryKeys.inventoryOverview');
});
```

- [ ] **Step 2: Run usage test and verify it fails**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/IngredientWorkspaceUsage.test.ts
```

Expected: fail because the source filter strings and `api.getInventoryOverview` are not present.

- [ ] **Step 3: Add inventory source filter state**

Modify `frontend/src/components/ingredients/useIngredientWorkspaceState.ts`:

```ts
export type InventorySourceFilter = 'all' | 'ingredient' | 'food';
```

Add to persisted state parsing:

```ts
function isInventorySourceFilter(value: unknown): value is InventorySourceFilter {
  return value === 'all' || value === 'ingredient' || value === 'food';
}
```

Add state inside `useIngredientWorkspaceState()`:

```ts
  const [inventorySourceFilter, setInventorySourceFilter] = useState<InventorySourceFilter>(
    isInventorySourceFilter(args.persistedWorkspaceState.inventorySourceFilter)
      ? args.persistedWorkspaceState.inventorySourceFilter
      : 'all'
  );
```

Add it to the returned state object:

```ts
    inventorySourceFilter,
    setInventorySourceFilter,
```

And add it to persisted state write:

```ts
      inventorySourceFilter,
```

- [ ] **Step 4: Query unified inventory overview in the workspace**

Modify imports in `frontend/src/components/ingredients/IngredientWorkspace.tsx`:

```ts
import {
  buildUnifiedInventoryGroups,
  buildUnifiedInventorySummary,
  filterUnifiedInventoryItems,
  getUnifiedInventoryActionLabel,
  getUnifiedInventorySourceLabel,
} from './inventoryOverviewModel';
```

Near the existing inventory search query, add:

```ts
  const inventoryOverviewQuery = useQuery({
    queryKey: queryKeys.inventoryOverview(inventorySourceFilter, inventorySearchValue),
    queryFn: () => api.getInventoryOverview({ scope: inventorySourceFilter, q: inventorySearchValue }),
    placeholderData: (previous) => previous,
  });
  const unifiedInventoryItems = inventoryOverviewQuery.data?.items ?? [];
  const filteredUnifiedInventoryItems = useMemo(
    () =>
      filterUnifiedInventoryItems(unifiedInventoryItems, {
        source: inventorySourceFilter,
        search: appliedInventorySearch,
      }),
    [appliedInventorySearch, inventorySourceFilter, unifiedInventoryItems]
  );
  const unifiedInventoryGroups = useMemo(
    () => buildUnifiedInventoryGroups(filteredUnifiedInventoryItems),
    [filteredUnifiedInventoryItems]
  );
  const unifiedInventorySummary = useMemo(
    () => buildUnifiedInventorySummary(filteredUnifiedInventoryItems),
    [filteredUnifiedInventoryItems]
  );
```

When rendering `IngredientInventoryPanel`, pass the new props:

```tsx
      inventorySourceFilter={inventorySourceFilter}
      onInventorySourceFilterChange={setInventorySourceFilter}
      unifiedInventoryItems={filteredUnifiedInventoryItems}
      unifiedInventoryGroups={unifiedInventoryGroups}
      unifiedInventorySummary={unifiedInventorySummary}
      isInventoryOverviewFetching={inventoryOverviewQuery.isFetching}
      getUnifiedInventoryActionLabel={getUnifiedInventoryActionLabel}
      getUnifiedInventorySourceLabel={getUnifiedInventorySourceLabel}
      onOpenFoodStock={(foodId) => {
        const food = props.foods.find((item) => item.id === foodId);
        if (food) handleOpenEdit(food);
      }}
      onRecordFoodStockMeal={(foodId) => {
        const food = props.foods.find((item) => item.id === foodId);
        if (food) openQuickMealDialog(food, getDefaultMealType(food), 'eat');
      }}
```

- [ ] **Step 5: Extend inventory panel props and toolbar**

Modify `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx` imports:

```ts
import type { InventoryOverviewItem } from '../../api/types';
import {
  getUnifiedInventoryActionLabel,
  getUnifiedInventorySourceLabel,
  type UnifiedInventoryGroup,
} from './inventoryOverviewModel';
import type { InventorySourceFilter } from './useIngredientWorkspaceState';
```

Extend `InventoryPanelProps`:

```ts
  inventorySourceFilter: InventorySourceFilter;
  onInventorySourceFilterChange: (value: InventorySourceFilter) => void;
  unifiedInventoryItems: InventoryOverviewItem[];
  unifiedInventoryGroups: UnifiedInventoryGroup[];
  unifiedInventorySummary: { totalCount: number; ingredientCount: number; foodCount: number; alertCount: number };
  isInventoryOverviewFetching?: boolean;
  onOpenFoodStock: (foodId: string) => void;
  onRecordFoodStockMeal: (foodId: string) => void;
```

Add this `OptionChipGroup` inside `.ingredients-inventory-filter-row` before the existing quick filter group:

```tsx
            <OptionChipGroup
              ariaLabel="库存来源筛选"
              value={props.inventorySourceFilter}
              options={[
                { value: 'all', label: '全部库存', description: String(props.unifiedInventorySummary.totalCount) },
                { value: 'ingredient', label: '食材库存', description: String(props.unifiedInventorySummary.ingredientCount) },
                { value: 'food', label: '成品速食', description: String(props.unifiedInventorySummary.foodCount) },
              ]}
              className="ingredients-inventory-source-chip-group"
              onChange={props.onInventorySourceFilterChange}
            />
```

Change toolbar summary:

```tsx
          <p className="ingredients-toolbar-summary">
            当前显示 {props.unifiedInventorySummary.totalCount} 项库存
            {props.unifiedInventorySummary.foodCount > 0 ? ` · 含 ${props.unifiedInventorySummary.foodCount} 个成品速食` : ''}
          </p>
```

- [ ] **Step 6: Add a food stock card component**

In `IngredientWorkspacePanels.tsx`, add before `IngredientInventoryPanel`:

```tsx
function UnifiedInventoryFoodCard(props: {
  item: InventoryOverviewItem;
  onRecordMeal: () => void;
  onEditStock: () => void;
}) {
  const actionLabel = getUnifiedInventoryActionLabel(props.item);
  const sourceLabel = getUnifiedInventorySourceLabel(props.item);
  const expiryLabel =
    props.item.days_until_expiry == null
      ? '未记录到期'
      : props.item.days_until_expiry < 0
        ? `已过期 ${Math.abs(props.item.days_until_expiry)} 天`
        : props.item.days_until_expiry === 0
          ? '今天到期'
          : `${props.item.days_until_expiry} 天后到期`;
  return (
    <article className={`ingredients-unified-inventory-card source-food tone-${props.item.tone}`}>
      <div className="ingredients-unified-inventory-main">
        <div className="ingredients-unified-inventory-media">
          <span>{props.item.title.slice(0, 1)}</span>
        </div>
        <div className="ingredients-unified-inventory-copy">
          <div className="ingredients-unified-inventory-head">
            <h3>{props.item.title}</h3>
            <span>{sourceLabel}</span>
          </div>
          <p>{props.item.category} · {props.item.purchase_source || '未记录来源'}</p>
          <strong>{props.item.quantity_label}</strong>
          <small>{expiryLabel}</small>
        </div>
      </div>
      <div className="ingredients-unified-inventory-actions">
        <ActionButton tone="secondary" size="compact" type="button" onClick={props.onRecordMeal}>
          {actionLabel}
        </ActionButton>
        <ActionButton tone="tertiary" size="compact" type="button" onClick={props.onEditStock}>
          编辑资料
        </ActionButton>
      </div>
    </article>
  );
}
```

Inside the inventory group rendering, render food stock rows before ingredient cards:

```tsx
              {group.items.map((item) =>
                item.source_type === 'food' ? (
                  <UnifiedInventoryFoodCard
                    key={item.id}
                    item={item}
                    onRecordMeal={() => props.onRecordFoodStockMeal(item.source_id)}
                    onEditStock={() => props.onOpenFoodStock(item.source_id)}
                  />
                ) : null
              )}
```

Keep the existing `InventoryIngredientCard` rendering for ingredient summaries. During this phase, the unified food cards appear in the same storage group list, and ingredient cards remain powered by the existing summary data.

- [ ] **Step 7: Add scoped styles**

Append to `frontend/src/styles/04-ingredients-workspace.css`:

```css
.ingredients-inventory-source-chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ingredients-unified-inventory-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  padding: 18px;
  border: 1px solid rgba(92, 67, 48, 0.12);
  border-radius: 20px;
  background: #fffdf9;
  box-shadow: 0 4px 12px rgba(74, 54, 40, 0.06);
}

.ingredients-unified-inventory-card.tone-warning {
  border-color: rgba(230, 154, 46, 0.28);
  background: #fff9eb;
}

.ingredients-unified-inventory-card.tone-danger {
  border-color: rgba(217, 75, 61, 0.28);
  background: #fff3f1;
}

.ingredients-unified-inventory-main {
  display: flex;
  min-width: 0;
  gap: 14px;
  align-items: center;
}

.ingredients-unified-inventory-media {
  display: grid;
  width: 58px;
  height: 58px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 18px;
  background: #f6efe7;
  color: #7a4d2d;
  font-weight: 700;
}

.ingredients-unified-inventory-copy {
  min-width: 0;
}

.ingredients-unified-inventory-head {
  display: flex;
  min-width: 0;
  gap: 8px;
  align-items: center;
}

.ingredients-unified-inventory-head h3 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ingredients-unified-inventory-head span {
  flex: 0 0 auto;
  padding: 4px 8px;
  border-radius: 999px;
  background: #eaf6ea;
  color: #4f7d45;
  font-size: 0.75rem;
  font-weight: 600;
}

.ingredients-unified-inventory-copy p,
.ingredients-unified-inventory-copy small {
  display: block;
  margin: 4px 0 0;
  color: var(--text-soft);
  font-size: 0.8125rem;
}

.ingredients-unified-inventory-copy strong {
  display: block;
  margin-top: 6px;
  color: var(--text);
  font-size: 1.125rem;
}

.ingredients-unified-inventory-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

@media (max-width: 767px) {
  .ingredients-unified-inventory-card {
    grid-template-columns: 1fr;
  }

  .ingredients-unified-inventory-actions {
    justify-content: stretch;
  }

  .ingredients-unified-inventory-actions button {
    min-height: 44px;
  }
}
```

- [ ] **Step 8: Run frontend usage test**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/IngredientWorkspaceUsage.test.ts src/components/ingredients/inventoryOverviewModel.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ingredients/useIngredientWorkspaceState.ts frontend/src/components/ingredients/IngredientWorkspace.tsx frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/styles/04-ingredients-workspace.css frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts
git commit -m "feat: show food stock in inventory workspace"
```

---

### Task 5: Food Quick Meal Stock Deduction UI

**Files:**
- Modify: `frontend/src/components/foods/FoodQuickMealDialog.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Modify: `frontend/src/styles/06-food-workspace.css`

**Interfaces:**
- Consumes: `QuickAddMealLogPayload.deduct_food_stock`, `stock_quantity`, `stock_unit` from Task 3.
- Produces: quick meal dialog that defaults to deducting one unit from ready-like food stock when stock is present.

- [ ] **Step 1: Add failing tests for quick meal stock copy**

Append to `frontend/src/components/foods/FoodWorkspace.test.ts`:

```ts
import { readFileSync } from 'node:fs';

it('quick meal dialog exposes ready food stock deduction controls', () => {
  const dialogSource = readFileSync('src/components/foods/FoodQuickMealDialog.tsx', 'utf8');
  expect(dialogSource).toContain('同步扣减库存');
  expect(dialogSource).toContain('stockQuantity');
  expect(dialogSource).toContain('deductStock');

  const workspaceSource = readFileSync('src/components/foods/FoodWorkspace.tsx', 'utf8');
  expect(workspaceSource).toContain('deduct_food_stock');
  expect(workspaceSource).toContain('stock_quantity');
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm --prefix frontend run test -- src/components/foods/FoodWorkspace.test.ts
```

Expected: fail because quick meal stock controls are not present.

- [ ] **Step 3: Extend quick meal dialog state and UI**

Modify `frontend/src/components/foods/FoodQuickMealDialog.tsx`:

```ts
export type FoodQuickMealDialogState = {
  action: 'cook' | 'eat';
  date: string;
  food: Food;
  mealType: MealType;
  recipeId?: string;
  deductStock?: boolean;
  stockQuantity?: string;
};
```

Extend `onChange` type:

```ts
  onChange: (patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType' | 'deductStock' | 'stockQuantity'>>) => void;
```

Inside the form after meal segments, add:

```tsx
          {!isCookAction && props.dialog.food.stock_quantity != null && props.dialog.food.stock_quantity > 0 && (
            <div className="food-quick-meal-stock-box">
              <label className="food-quick-meal-stock-toggle">
                <input
                  type="checkbox"
                  checked={props.dialog.deductStock ?? true}
                  disabled={isSubmitting}
                  onChange={(event) => props.onChange({ deductStock: event.target.checked })}
                />
                <span>
                  <strong>同步扣减库存</strong>
                  <small>当前剩余 {props.dialog.food.stock_quantity}{props.dialog.food.stock_unit || '份'}</small>
                </span>
              </label>
              {(props.dialog.deductStock ?? true) && (
                <label className="food-quick-meal-stock-quantity">
                  <span>扣减数量</span>
                  <input
                    className="text-input"
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={props.dialog.stockQuantity ?? '1'}
                    disabled={isSubmitting}
                    onChange={(event) => props.onChange({ stockQuantity: event.target.value })}
                  />
                  <em>{props.dialog.food.stock_unit || '份'}</em>
                </label>
              )}
            </div>
          )}
```

- [ ] **Step 4: Default and submit the stock deduction payload**

Modify `openQuickMealDialog()` in `frontend/src/components/foods/FoodWorkspace.tsx`:

```ts
  const shouldDeductStock =
    action === 'eat' &&
    isReadyLikeFood(food) &&
    food.stock_quantity !== null &&
    food.stock_quantity !== undefined &&
    food.stock_quantity > 0;
  setQuickMealDialog({
    action,
    date: todayKey(),
    food,
    mealType,
    recipeId: action === 'cook' ? food.recipe_id ?? undefined : undefined,
    deductStock: shouldDeductStock,
    stockQuantity: shouldDeductStock ? '1' : '',
  });
```

Modify `submitQuickMealDialog()`:

```ts
    const stockQuantity = Number(current.stockQuantity || 1);
    await quickAdd(current.food, current.mealType, current.date, {
      deduct_food_stock: Boolean(current.deductStock),
      stock_quantity: current.deductStock && Number.isFinite(stockQuantity) ? stockQuantity : null,
      stock_unit: current.food.stock_unit || '份',
    });
```

Modify the local `quickAdd()` helper signature in `FoodWorkspace.tsx` to accept the optional patch and include it in `props.quickAddMealLog()`:

```ts
  async function quickAdd(
    food: Food,
    mealType: MealType,
    date: string,
    stockPatch: Pick<QuickAddMealLogPayload, 'deduct_food_stock' | 'stock_quantity' | 'stock_unit'> = {}
  ) {
    await props.quickAddMealLog({
      food_id: food.id,
      date,
      meal_type: mealType,
      servings: 1,
      note: '',
      ...stockPatch,
    });
    setFeedback(`${food.name} 已记录到${date === todayKey() ? '今天' : formatDate(date)}${MEAL_TYPE_LABELS[mealType]}`);
  }
```

- [ ] **Step 5: Add food quick meal styles**

Append to `frontend/src/styles/06-food-workspace.css`:

```css
.food-quick-meal-stock-box {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(92, 67, 48, 0.12);
  border-radius: 18px;
  background: #fffaf1;
}

.food-quick-meal-stock-toggle {
  display: flex;
  gap: 10px;
  align-items: center;
  color: var(--text);
}

.food-quick-meal-stock-toggle input {
  width: 18px;
  height: 18px;
}

.food-quick-meal-stock-toggle span {
  display: grid;
  gap: 2px;
}

.food-quick-meal-stock-toggle small {
  color: var(--text-soft);
  font-size: 0.8125rem;
}

.food-quick-meal-stock-quantity {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px auto;
  gap: 8px;
  align-items: center;
}

.food-quick-meal-stock-quantity span {
  color: var(--text-soft);
  font-size: 0.875rem;
  font-weight: 600;
}

.food-quick-meal-stock-quantity em {
  color: var(--text-soft);
  font-style: normal;
}

@media (max-width: 767px) {
  .food-quick-meal-stock-quantity {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 6: Run food frontend tests**

Run:

```bash
npm --prefix frontend run test -- src/components/foods/FoodWorkspace.test.ts src/components/foods/FoodQuickMealDialog.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/foods/FoodQuickMealDialog.tsx frontend/src/components/foods/FoodWorkspace.tsx frontend/src/components/foods/FoodWorkspace.test.ts frontend/src/styles/06-food-workspace.css
git commit -m "feat: deduct ready food stock from quick meals"
```

---

### Task 6: AI Inventory Query Includes Food Stock

**Files:**
- Modify: `backend/app/ai/tools/catalog/inventory.py`
- Modify: `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/food-profile/SKILL.md`
- Test: `backend/tests/ai_infra/test_inventory_operations.py`

**Interfaces:**
- Consumes: `build_inventory_overview()` from Task 1.
- Produces: `inventory.read_summary` card data that may include `sourceType="food"` rows, and skill guidance for food-stock write routing.

- [ ] **Step 1: Add failing AI inventory summary test**

Append to `backend/tests/ai_infra/test_inventory_operations.py`:

```python
        def test_inventory_summary_includes_ready_food_stock(self) -> None:
            with self.db_session() as db:
                db.add(
                    Food(
                        id="food-ai-stock-yogurt",
                        family_id=self.family.id,
                        name="蓝莓酸奶",
                        type="readyMade",
                        category="饮品",
                        flavor_tags=[],
                        scene_tags=[],
                        suitable_meal_types=["breakfast"],
                        source_name="盒马",
                        purchase_source="盒马",
                        scene="",
                        notes="",
                        routine_note="",
                        stock_quantity=Decimal("2"),
                        stock_unit="盒",
                        expiry_date=today_for_family(self.family.id),
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()
                executor = self.build_executor(db)

                summary = executor.call("inventory.read_summary", {"days": 7})

                food_items = [
                    item
                    for item in summary["items"]
                    if item.get("sourceType") == "food" and item.get("foodId") == "food-ai-stock-yogurt"
                ]
                self.assertEqual(len(food_items), 1)
                self.assertEqual(food_items[0]["name"], "蓝莓酸奶")
                self.assertEqual(food_items[0]["quantity"], "2盒")
                self.assertEqual(summary["card"]["data"]["foodStockCount"], 1)
```

If `Food`, `Decimal`, or `today_for_family` are not already imported at the top of the test file, add:

```python
from decimal import Decimal
from app.models.domain import Food
from app.services.clock import today_for_family
```

- [ ] **Step 2: Run AI test and verify it fails**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_inventory_operations.py::InventoryOperationTests::test_inventory_summary_includes_ready_food_stock -q
```

Expected: fail because `inventory.read_summary` only reads `InventoryItem`.

- [ ] **Step 3: Expand inventory AI item schema**

Modify `INVENTORY_ITEM_OUTPUT` in `backend/app/ai/tools/catalog/inventory.py`:

```python
        "sourceType": {"type": "string", "enum": ["ingredient", "food"]},
        "foodId": {"type": ["string", "null"]},
        "inventoryItemId": {"type": ["string", "null"]},
```

Keep `ingredientId` for existing clients, but allow it to be nullable:

```python
        "ingredientId": {"type": ["string", "null"]},
```

- [ ] **Step 4: Add AI records from overview rows**

In `backend/app/ai/tools/catalog/inventory.py`, import:

```python
from app.services.inventory_overview import build_inventory_overview
```

Add helper:

```python
def overview_inventory_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "sourceType": row["source_type"],
        "foodId": row["source_id"] if row["source_type"] == "food" else None,
        "ingredientId": row["source_id"] if row["source_type"] == "ingredient" else None,
        "inventoryItemId": row.get("inventory_item_id"),
        "name": row["title"],
        "image": row.get("image"),
        "quantity": row["quantity_label"],
        "unit": row["unit"],
        "quantityTrackingMode": row["quantity_tracking_mode"],
        "status": row.get("status") or "food_stock",
        "displayStatus": "expired" if row["tone"] == "danger" else "expiring" if row["tone"] == "warning" else "available",
        "expiryDate": row["expiry_date"].isoformat() if hasattr(row.get("expiry_date"), "isoformat") else row.get("expiry_date"),
        "daysUntilExpiry": row.get("days_until_expiry"),
        "lowStockThreshold": None,
        "purchaseDate": "",
        "storageLocation": row["storage_location"],
        "suggestedAction": row["primary_action"],
    }
```

Replace the body of `inventory_read_summary()` with:

```python
def inventory_read_summary(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    days = int(payload.get("days") or 7)
    overview = build_inventory_overview(
        context.db,
        family_id=context.family_id,
        scope="all",
        query="",
        today=today,
    )
    rows = overview["items"]
    expiring = [
        row
        for row in rows
        if row.get("days_until_expiry") is not None and 0 <= row["days_until_expiry"] <= days
    ]
    low_stock = [
        row
        for row in rows
        if row["source_type"] == "ingredient" and row["tone"] == "warning" and row.get("days_until_expiry") is None
    ]
    selected_rows = expiring[:6] or low_stock[:6] or rows[:6]
    records = [overview_inventory_record(row) for row in selected_rows]
    data = {
        "queryFocus": "overview",
        "availableCount": overview["summary"]["total_count"],
        "expiringCount": len(expiring),
        "lowStockCount": len(low_stock),
        "foodStockCount": overview["summary"]["food_count"],
        "items": records,
    }
    return {
        **data,
        "card": {
            "id": create_id("ai_card"),
            "type": "inventory_summary",
            "title": "库存概览",
            "data": data,
        },
    }
```

- [ ] **Step 5: Update skill guidance**

In `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`, change the description first line to:

```markdown
description: 查询家庭库存概览、可用库存、临期、过期和低库存；库存查询包含食材库存以及成品/速食食物库存；食材入库、消耗和销毁通过确认草稿处理。
```

Add this under `## 适用范围`:

```markdown
- 查询家庭库存时同时覆盖两类库存：食材库存来自 `InventoryItem`，成品/速食库存来自食物资料中的 `stock_quantity`、`stock_unit` 和 `expiry_date`。
- 成品/速食库存只用于“家里还有什么、什么快过期、今天可直接吃什么”的库存判断；不能当作菜谱原料，也不能替代真实食材 ID。
```

Add this under `## 执行规则`:

```markdown
- 如果用户要修改成品/速食的库存数量、到期日或购买渠道，不要调用 `inventory.create_operation_draft`，因为它只处理真实食材库存。应说明这是食物资料库存，并让 Orchestrator 进入 `food_profile` 流程生成 food_profile 更新草稿。
```

In `backend/app/ai/skills/catalog/food-profile/SKILL.md`, add under `## 适用范围`:

```markdown
- 更新成品、速食、包装食品的库存字段，包括剩余数量、单位、到期日期和购买渠道；这些字段属于食物资料，不属于食材库存批次。
```

- [ ] **Step 6: Run AI tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_inventory_operations.py::InventoryOperationTests::test_inventory_summary_includes_ready_food_stock -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_registry_and_metrics.py -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/ai/tools/catalog/inventory.py backend/app/ai/skills/catalog/inventory-analysis/SKILL.md backend/app/ai/skills/catalog/food-profile/SKILL.md backend/tests/ai_infra/test_inventory_operations.py
git commit -m "feat: include food stock in AI inventory summaries"
```

---

### Task 7: Mobile Inventory Summary Integration

**Files:**
- Modify: `frontend/src/components/ingredients/IngredientMobileView.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/styles/07-mobile.css`
- Test: `frontend/src/components/ingredients/IngredientMobileViewUsage.test.ts`

**Interfaces:**
- Consumes: `InventoryOverviewItem[]` from Task 4.
- Produces: mobile inventory page metrics and priority rail that count ready-like food stock alongside ingredient stock.

- [ ] **Step 1: Add failing mobile usage test**

Append to `frontend/src/components/ingredients/IngredientMobileViewUsage.test.ts`:

```ts
import { readFileSync } from 'node:fs';

it('mobile ingredient page can present ready food stock', () => {
  const mobileSource = readFileSync('src/components/ingredients/IngredientMobileView.tsx', 'utf8');
  expect(mobileSource).toContain('mobileFoodStockItems');
  expect(mobileSource).toContain('成品速食');
  expect(mobileSource).toContain('记到今天');

  const workspaceSource = readFileSync('src/components/ingredients/IngredientWorkspace.tsx', 'utf8');
  expect(workspaceSource).toContain('mobileFoodStockItems');
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/IngredientMobileViewUsage.test.ts
```

Expected: fail because mobile food stock props are not present.

- [ ] **Step 3: Extend mobile props and render food stock priority cards**

Modify `IngredientMobileViewProps` in `frontend/src/components/ingredients/IngredientMobileView.tsx`:

```ts
  mobileFoodStockItems: InventoryOverviewItem[];
  openFoodStockMeal: (foodId: string) => void;
  openFoodStockEditor: (foodId: string) => void;
```

Add `InventoryOverviewItem` import:

```ts
import type { InventoryOverviewItem, ShoppingListItem } from '../../api/types';
```

Inside the hero metrics, change the stocked label count:

```tsx
              <strong>{props.stockedIngredientCount + props.mobileFoodStockItems.length}</strong>
              <span>在库</span>
```

After the ingredient priority scroller section, add:

```tsx
        {props.mobileFoodStockItems.length > 0 && (
          <div className="mobile-food-stock-strip" aria-label="成品速食库存">
            {props.mobileFoodStockItems.slice(0, 6).map((item) => (
              <article key={item.id} className={`mobile-food-stock-card tone-${item.tone}`}>
                <div>
                  <span>成品速食</span>
                  <h3>{item.title}</h3>
                  <p>{item.quantity_label} · {item.days_until_expiry == null ? '未记录到期' : item.days_until_expiry <= 0 ? '今天需处理' : `${item.days_until_expiry} 天后到期`}</p>
                </div>
                <div className="mobile-food-stock-card-actions">
                  <button type="button" className="mobile-ingredient-primary compact" onClick={() => props.openFoodStockMeal(item.source_id)}>
                    记到今天
                  </button>
                  <button type="button" onClick={() => props.openFoodStockEditor(item.source_id)}>
                    编辑
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
```

- [ ] **Step 4: Pass mobile food stock props**

In `frontend/src/components/ingredients/IngredientWorkspace.tsx`, derive:

```ts
  const mobileFoodStockItems = filteredUnifiedInventoryItems.filter((item) => item.source_type === 'food');
```

Pass to `IngredientMobileView`:

```tsx
      mobileFoodStockItems={mobileFoodStockItems}
      openFoodStockMeal={(foodId) => {
        const food = props.foods.find((item) => item.id === foodId);
        if (food) openQuickMealDialog(food, getDefaultMealType(food), 'eat');
      }}
      openFoodStockEditor={(foodId) => {
        const food = props.foods.find((item) => item.id === foodId);
        if (food) handleOpenEdit(food);
      }}
```

- [ ] **Step 5: Add mobile styles**

Append to `frontend/src/styles/07-mobile.css`:

```css
.mobile-food-stock-strip {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.mobile-food-stock-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid rgba(92, 67, 48, 0.12);
  border-radius: 20px;
  background: #fffdf9;
}

.mobile-food-stock-card.tone-warning {
  border-color: rgba(230, 154, 46, 0.28);
  background: #fff8e8;
}

.mobile-food-stock-card.tone-danger {
  border-color: rgba(217, 75, 61, 0.28);
  background: #fff1ee;
}

.mobile-food-stock-card span {
  color: #7c6a5e;
  font-size: 0.75rem;
  font-weight: 700;
}

.mobile-food-stock-card h3 {
  margin: 4px 0;
  color: var(--text);
  font-size: 1rem;
}

.mobile-food-stock-card p {
  margin: 0;
  color: var(--text-soft);
  font-size: 0.875rem;
}

.mobile-food-stock-card-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.mobile-food-stock-card-actions button {
  min-height: 44px;
}
```

- [ ] **Step 6: Run mobile usage test**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/IngredientMobileViewUsage.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ingredients/IngredientMobileView.tsx frontend/src/components/ingredients/IngredientWorkspace.tsx frontend/src/styles/07-mobile.css frontend/src/components/ingredients/IngredientMobileViewUsage.test.ts
git commit -m "feat: surface food stock on mobile inventory"
```

---

### Task 8: Cross-Path Verification And Documentation Notes

**Files:**
- Modify: `docs/ai-assistant-standards.md`
- Test: existing backend and frontend suites

**Interfaces:**
- Consumes: all previous tasks.
- Produces: final verified implementation with documented domain boundary.

- [ ] **Step 1: Document the domain boundary**

In `docs/ai-assistant-standards.md`, add this bullet to the inventory section near the existing inventory rules:

```markdown
12. 家庭库存查询可以同时展示食材库存和成品/速食食物库存；食材库存写操作仍走 `inventory_operation`，成品/速食库存字段属于 `food_profile`，不能把食物库存伪装成食材库存批次。
```

- [ ] **Step 2: Run backend focused tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/inventory/test_inventory_overview.py backend/tests/recipes/test_food_stock_operations.py backend/tests/inventory/test_inventory_api.py backend/tests/recipes/test_food_workspace.py backend/tests/recipes/test_food_queries.py backend/tests/ai_infra/test_inventory_operations.py -q
```

Expected: pass.

- [ ] **Step 3: Run frontend focused tests**

Run:

```bash
npm --prefix frontend run test -- src/components/ingredients/inventoryOverviewModel.test.ts src/components/ingredients/IngredientWorkspaceUsage.test.ts src/components/ingredients/IngredientMobileViewUsage.test.ts src/components/foods/FoodWorkspace.test.ts src/components/foods/FoodQuickMealDialog.test.tsx
```

Expected: pass.

- [ ] **Step 4: Run full frontend build**

Run:

```bash
npm --prefix frontend run build
```

Expected: pass TypeScript build, Vite build, and bundle checks.

- [ ] **Step 5: Run mobile smoke because inventory mobile UI changed**

Run:

```bash
npm --prefix frontend run smoke
```

Expected: pass all smoke assertions.

- [ ] **Step 6: Run backend full test if focused backend tests pass**

Run:

```bash
npm run backend:test
```

Expected: pass.

- [ ] **Step 7: Check formatting whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 8: Commit documentation and verification adjustments**

```bash
git add docs/ai-assistant-standards.md
git commit -m "docs: clarify food stock inventory boundary"
```

---

## Self-Review Notes

- Spec coverage: Task 1 creates unified read projection; Task 2 adds food stock actions and quick meal stock deduction; Tasks 3-5 connect frontend API, desktop inventory, and quick meal UI; Task 6 connects AI inventory query visibility and skill boundaries; Task 7 covers mobile inventory; Task 8 covers docs and verification.
- Scope check: multi-batch ready-food inventory is deliberately excluded from phase one because it requires a new table and migration. Phase one uses current `Food.stock_quantity`, `Food.stock_unit`, and `Food.expiry_date` fields.
- Type consistency: the plan consistently uses `source_type`, `source_id`, `InventoryOverviewItem`, `inventoryOverview()`, and `FoodStockChangePayload`.
- Placeholder scan: no unresolved placeholder markers are present.
