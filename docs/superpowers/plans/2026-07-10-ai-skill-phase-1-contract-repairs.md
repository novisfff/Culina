# AI Skill Phase 1 Contract Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the currently observable Skill/Tool contract gaps without changing the v2 Skill architecture, stable Skill keys, draft types, or approval flow.

**Architecture:** Keep the current `SkillDirectoryLoader`, `WorkspaceOrchestratorAgent`, draft tools, and approval commit services. Make the declared Skill capabilities executable, give every AI run a deterministic `Asia/Shanghai` time context, align inventory card output with the Skill promise, and remove unsafe default assumptions from Skill instructions.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, Pydantic, LangGraph, pytest, React 18, TypeScript, Vitest.

## Global Constraints

- Keep all existing Skill keys, draft types, schema versions, approval types, and commit handlers unchanged.
- Models must still receive no `write` tools; formal writes remain `draft -> approval -> commit`.
- Shopping create/update payloads must bind exactly one current-family `ingredientId` or ready-like `foodId`; no free-text fallback is allowed.
- `ingredient.search` and `food.search` are candidate recall only; search results are not permission to invent or cross-bind IDs.
- Use `Asia/Shanghai` as the deterministic product timezone in this phase; per-family configurable timezone is intentionally deferred.
- Do not add a database migration in this phase.
- Do not change the frontend visual design.
- All user-visible copy remains Simplified Chinese.
- Report every verification command actually run during implementation.

---

## File Structure

Create:

- `backend/tests/core/test_family_clock.py`: deterministic timezone boundary tests.
- `backend/tests/ai_infra/test_skill_contract_repairs.py`: shopping, time-context, inventory-card, and Skill instruction regression tests.

Modify:

- `backend/app/services/clock.py`: convert UTC instants into deterministic family-local time.
- `backend/app/ai/workflows/orchestrator/payloads.py`: expose `timeContext` to the provider.
- `backend/app/ai/skills/catalog/shopping-list/skill.yaml`: authorize Food lookup tools and completion hints.
- `backend/app/ai/tools/catalog/shopping.py`: return the complete shopping target identity.
- `backend/app/ai/tools/catalog/inventory.py`: return `inventory_summary` cards for all inventory query focuses and include zero-stock ingredients in low-stock results.
- `backend/app/services/ai_operations/experience.py`: allow a zero-stock ingredient card row to create a restock draft without a batch ID.
- `backend/app/schemas/ai.py`: align inventory card DTOs with ingredient and Food result identities.
- `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml`: mark all inventory query tools as terminal card outputs.
- `backend/app/ai/skills/catalog/food-profile/SKILL.md`: stop defaulting unknown storage to `常温`.
- `docs/ai-assistant-standards.md`: document all nine loaded Skills and the fixed cooking profile.
- `backend/tests/ai_infra/test_skill_loader.py`: assert the corrected manifest contract.
- `backend/tests/ai_infra/test_inventory_operations.py`: cover focused inventory cards and depleted ingredients.
- `backend/tests/ai_infra/test_orchestrator_profiles.py`: cover provider `timeContext`.
- `frontend/src/api/types.ts`: align inventory card item identity with backend output.
- `frontend/src/components/ai/AiResultCards.test.tsx`: cover depleted ingredient and Food rows.

No third-party dependencies are added.

---

### Task 1: Make Ready-Like Food Shopping Executable

**Files:**
- Create: `backend/tests/ai_infra/test_skill_contract_repairs.py`
- Modify: `backend/app/ai/skills/catalog/shopping-list/skill.yaml`
- Modify: `backend/app/ai/tools/catalog/shopping.py`
- Modify: `backend/tests/ai_infra/test_skill_loader.py`

**Interfaces:**
- Consumes: `build_workspace_skill_registry()`, `serialize_shopping_tool_item(item) -> dict[str, Any]`.
- Produces: shopping Tool outputs containing `ingredientId`, `foodId`, and `targetType`; a `shopping_list` manifest that authorizes Food lookup.

- [ ] **Step 1: Write failing manifest and serializer tests**

Create `backend/tests/ai_infra/test_skill_contract_repairs.py`:

```python
from __future__ import annotations

from decimal import Decimal

from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.tools.catalog.shopping import serialize_shopping_tool_item
from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import ShoppingListItem


def test_shopping_skill_authorizes_food_target_lookup() -> None:
    tools = set(build_workspace_skill_registry().get("shopping_list").manifest.tools)

    assert {"food.search", "food.read_by_id"}.issubset(tools)


def test_shopping_tool_item_preserves_food_target_identity() -> None:
    item = ShoppingListItem(
        id="shopping-ready-yogurt",
        family_id="family-1",
        ingredient_id=None,
        food_id="food-yogurt",
        title="蓝莓酸奶",
        quantity=Decimal("2"),
        unit="盒",
        quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        display_label=None,
        reason="早餐备用",
        done=False,
        created_by="user-1",
        updated_by="user-1",
    )

    payload = serialize_shopping_tool_item(item)

    assert payload["ingredientId"] is None
    assert payload["foodId"] == "food-yogurt"
    assert payload["targetType"] == "food"
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_repairs.py -q
```

Expected: two failures, one because Food tools are absent and one because `foodId`/`targetType` are absent.

- [ ] **Step 3: Authorize Food lookup in the shopping manifest**

Add the following entries to `allowed_tools` in `backend/app/ai/skills/catalog/shopping-list/skill.yaml`, immediately after the ingredient tools:

```yaml
- food.search
- food.read_by_id
```

Add these entries to `completion_policy.followup_required_tools`:

```yaml
    food.search: 食物检索后必须说明可采购的成品、速食或包装食品候选，请求用户选择，或生成 shopping_list 草稿。
    food.read_by_id: 读取食物资料后必须确认它属于 readyMade、instant 或 packaged，再说明如何加入清单、请求补充信息，或生成 shopping_list 草稿。
```

- [ ] **Step 4: Return complete target identity from shopping reads**

Replace `SHOPPING_ITEM_OUTPUT` properties and `serialize_shopping_tool_item()` target fields with:

```python
"ingredientId": {"type": ["string", "null"]},
"foodId": {"type": ["string", "null"]},
"targetType": {"type": "string", "enum": ["ingredient", "food"]},
```

```python
def serialize_shopping_tool_item(item: ShoppingListItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "ingredientId": item.ingredient_id,
        "foodId": item.food_id,
        "targetType": "food" if item.food_id else "ingredient",
        "title": item.title,
        "quantity": float(item.quantity),
        "unit": item.unit,
        "quantityMode": item.quantity_mode.value if hasattr(item.quantity_mode, "value") else item.quantity_mode,
        "displayLabel": item.display_label,
        "reason": item.reason,
        "done": item.done,
        "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
    }
```

Also add `foodId` and `targetType` to `SHOPPING_ITEM_OUTPUT["required"]`.

- [ ] **Step 5: Strengthen the existing loader assertion**

In `backend/tests/ai_infra/test_skill_loader.py`, extend the manifest test with:

```python
self.assertIn("food.search", skill_registry.get("shopping_list").manifest.tools)
self.assertIn("food.read_by_id", skill_registry.get("shopping_list").manifest.tools)
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_skill_contract_repairs.py \
  backend/tests/ai_infra/test_skill_loader.py -q
```

Expected: all tests pass.

Commit:

```bash
git add backend/app/ai/skills/catalog/shopping-list/skill.yaml backend/app/ai/tools/catalog/shopping.py backend/tests/ai_infra/test_skill_contract_repairs.py backend/tests/ai_infra/test_skill_loader.py
git commit -m "fix: complete AI shopping food target contract"
```

---

### Task 2: Introduce a Deterministic Family Clock

**Files:**
- Create: `backend/tests/core/test_family_clock.py`
- Modify: `backend/app/services/clock.py`

**Interfaces:**
- Consumes: timezone-aware `datetime` values.
- Produces: `DEFAULT_FAMILY_TIMEZONE`, `family_timezone()`, `today_for_family()`, and `now_for_family()`.

- [ ] **Step 1: Write timezone boundary tests**

Create `backend/tests/core/test_family_clock.py`:

```python
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.services.clock import family_timezone, now_for_family, today_for_family


def test_family_clock_uses_shanghai_date_at_utc_day_boundary() -> None:
    instant = datetime(2026, 7, 9, 16, 30, tzinfo=UTC)

    assert today_for_family("family-1", at=instant).isoformat() == "2026-07-10"
    assert now_for_family("family-1", at=instant).isoformat() == "2026-07-10T00:30:00+08:00"


def test_family_timezone_rejects_unknown_zone() -> None:
    with pytest.raises(ValueError, match="无效的家庭时区"):
        family_timezone("Mars/Olympus")
```

- [ ] **Step 2: Run the clock tests and verify failure**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/core/test_family_clock.py -q
```

Expected: fail because the current clock returns UTC values and `family_timezone` does not exist.

- [ ] **Step 3: Implement the deterministic clock**

Replace `backend/app/services/clock.py` with:

```python
from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_FAMILY_TIMEZONE = "Asia/Shanghai"


def family_timezone(timezone_name: str = DEFAULT_FAMILY_TIMEZONE) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"无效的家庭时区：{timezone_name}") from exc


def now_utc() -> datetime:
    return datetime.now(UTC)


def now_for_family(
    family_id: str | None = None,
    *,
    at: datetime | None = None,
    timezone_name: str = DEFAULT_FAMILY_TIMEZONE,
) -> datetime:
    del family_id
    instant = at or now_utc()
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    return instant.astimezone(family_timezone(timezone_name))


def today_for_family(
    family_id: str | None = None,
    *,
    at: datetime | None = None,
    timezone_name: str = DEFAULT_FAMILY_TIMEZONE,
) -> date:
    return now_for_family(family_id, at=at, timezone_name=timezone_name).date()
```

- [ ] **Step 4: Run clock and affected inventory tests**

Run:

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/core/test_family_clock.py \
  backend/tests/inventory \
  backend/tests/search/test_hybrid_search.py -q
```

Expected: all tests pass with Shanghai-local date semantics.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/clock.py backend/tests/core/test_family_clock.py
git commit -m "fix: use deterministic family local time"
```

---

### Task 3: Expose Time Context to the Orchestrator

**Files:**
- Modify: `backend/app/ai/workflows/orchestrator/payloads.py`
- Modify: `backend/tests/ai_infra/test_orchestrator_profiles.py`
- Modify: `backend/tests/ai_infra/test_skill_contract_repairs.py`

**Interfaces:**
- Consumes: `now_for_family(context.family_id)`.
- Produces: provider payload field `timeContext` with exact camelCase keys.

- [ ] **Step 1: Write a failing payload contract test**

Add this self-contained test to `backend/tests/ai_infra/test_orchestrator_profiles.py`:

```python
from datetime import datetime
from unittest.mock import patch


def test_orchestrator_payload_contains_family_local_time(self) -> None:
    builder = OrchestratorPromptPayloadBuilder(
        SkillInjectionManager(build_workspace_skill_registry())
    )
    context = SkillContext(
        db=MagicMock(),
        family_id=self.family.id,
        user_id=self.user.id,
        conversation_id="conversation-time-context",
        run_id="run-time-context",
        conversation=[],
        current_message="今晚吃什么？",
        subject={},
        tool_executor=ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-time-context",
                run_id="run-time-context",
            ),
        ),
    )

    with patch(
        "app.ai.workflows.orchestrator.payloads.now_for_family",
        return_value=datetime.fromisoformat("2026-07-10T18:30:00+08:00"),
    ):
        payload = builder.user_payload(context, [], [])

    self.assertEqual(
        payload["timeContext"],
        {
            "timezone": "Asia/Shanghai",
            "localDate": "2026-07-10",
            "localDateTime": "2026-07-10T18:30:00+08:00",
            "suggestedMealType": "dinner",
        },
    )
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_repairs.py -q
```

Expected: fail with `KeyError: 'timeContext'`.

- [ ] **Step 3: Add the time-context builder**

In `backend/app/ai/workflows/orchestrator/payloads.py`, add:

```python
from app.services.clock import DEFAULT_FAMILY_TIMEZONE, now_for_family


def _suggested_meal_type(local_hour: int) -> str:
    if 5 <= local_hour < 10:
        return "breakfast"
    if 10 <= local_hour < 15:
        return "lunch"
    if 17 <= local_hour < 22:
        return "dinner"
    return "snack"


def _time_context(family_id: str) -> dict[str, str]:
    local_now = now_for_family(family_id)
    return {
        "timezone": DEFAULT_FAMILY_TIMEZONE,
        "localDate": local_now.date().isoformat(),
        "localDateTime": local_now.isoformat(),
        "suggestedMealType": _suggested_meal_type(local_now.hour),
    }
```

Add this field to `user_payload()`:

```python
"timeContext": _time_context(context.family_id),
```

- [ ] **Step 4: Extend the existing profile payload test**

In `backend/tests/ai_infra/test_orchestrator_profiles.py`, assert:

```python
self.assertEqual(provider.user_payload["timeContext"]["timezone"], "Asia/Shanghai")
self.assertRegex(provider.user_payload["timeContext"]["localDate"], r"^\d{4}-\d{2}-\d{2}$")
self.assertIn(
    provider.user_payload["timeContext"]["suggestedMealType"],
    {"breakfast", "lunch", "dinner", "snack"},
)
```

- [ ] **Step 5: Run focused tests and commit**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_skill_contract_repairs.py \
  backend/tests/ai_infra/test_orchestrator_profiles.py -q
```

Expected: all tests pass.

```bash
git add backend/app/ai/workflows/orchestrator/payloads.py backend/tests/ai_infra/test_orchestrator_profiles.py backend/tests/ai_infra/test_skill_contract_repairs.py
git commit -m "feat: expose local time context to AI skills"
```

---

### Task 4: Make Every Inventory Query Produce a Real Card

**Files:**
- Modify: `backend/app/ai/tools/catalog/inventory.py`
- Modify: `backend/app/services/ai_operations/experience.py`
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml`
- Modify: `backend/tests/ai_infra/test_inventory_operations.py`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/ai/AiResultCards.test.tsx`

**Interfaces:**
- Consumes: inventory query result dictionaries containing `queryFocus`, `items`, and `count`.
- Produces: `_inventory_summary_card(data, title) -> dict[str, Any]`, terminal card outputs from every inventory read tool, and a working zero-stock restock action.

- [ ] **Step 1: Write failing focused-card tests**

Add tests to `backend/tests/ai_infra/test_inventory_operations.py` that execute `inventory.read_expiring_items` and `inventory.read_low_stock_items`, then assert:

```python
assert output["card"]["type"] == "inventory_summary"
assert output["card"]["data"]["queryFocus"] == "expiring"
assert output["card"]["data"]["expiringCount"] == output["count"]
```

For the depleted case, create an `Ingredient` with `default_low_stock_threshold=Decimal("2")` and no positive `InventoryItem`, then assert the low-stock output includes:

```python
assert any(
    item["ingredientId"] == depleted.id and item["quantity"] == "0"
    for item in output["items"]
)
```

Add a quick-action test that persists the card, requests `restock` for
`item_id=f"ingredient:{depleted.id}"`, and asserts the generated
`inventory_operation` draft has the real ingredient ID and a null
`inventoryItemId`. Add a Food card case asserting no unsupported ingredient
quick-action is exposed.

- [ ] **Step 2: Run the focused inventory tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_inventory_operations.py -q
```

Expected: focused queries have no `card`, and the depleted ingredient is missing.

- [ ] **Step 3: Add a shared inventory-card constructor**

In `backend/app/ai/tools/catalog/inventory.py`, add:

```python
def _inventory_summary_card(data: dict[str, Any], *, title: str) -> dict[str, Any]:
    focus = str(data["queryFocus"])
    items = list(data.get("items") or [])
    count = int(data.get("count") or len(items))
    card_data = {
        "queryFocus": focus,
        "availableCount": (
            int(data["availableCount"])
            if focus == "overview"
            else count if focus == "available" else 0
        ),
        "expiringCount": (
            int(data["expiringCount"])
            if focus == "overview"
            else count if focus == "expiring" else 0
        ),
        "expiredCount": count if focus == "expired" else 0,
        "lowStockCount": (
            int(data["lowStockCount"])
            if focus == "overview"
            else count if focus == "low_stock" else 0
        ),
        "foodStockCount": (
            int(data["foodStockCount"])
            if focus == "overview"
            else sum(
                item.get("sourceType") == "food"
                for item in items
            )
        ),
        "items": items,
    }
    return {
        "id": create_id("ai_card"),
        "type": "inventory_summary",
        "title": title,
        "data": card_data,
    }


def _with_inventory_card(data: dict[str, Any], *, title: str) -> dict[str, Any]:
    return {**data, "card": _inventory_summary_card(data, title=title)}
```

Wrap the focused query returns:

```python
return _with_inventory_card(
    {"queryFocus": "expiring", "items": records, "count": len(records)},
    title="临期库存",
)
```

Use titles `可用库存`, `临期库存`, `过期库存`, and `低库存提醒` for their respective tools. Refactor `inventory_read_summary()` to call `_inventory_summary_card(data, title="库存概览")` instead of building a second card shape.

Update `inventory_items_output_schema()` so focused reads require the same
`card` object shape. Extend `AIInventorySummaryCardDataDTO` with
`queryFocus`, `expiredCount`, and `foodStockCount`. Extend
`AIInventoryResultItemDTO` so `sourceType` is required while
`ingredientId`, `foodId`, and `inventoryItemId` are nullable, matching
`INVENTORY_ITEM_OUTPUT`. Mirror those fields in `AiInventoryResultItem` and
`AiInventorySummaryCardData`.

- [ ] **Step 4: Include depleted ingredients in low-stock output**

Load ingredients with a positive `default_low_stock_threshold`, aggregate remaining inventory by ingredient, and append zero rows using this exact output identity:

```python
{
    "id": f"ingredient:{ingredient.id}",
    "sourceType": "ingredient",
    "inventoryItemId": None,
    "ingredientId": ingredient.id,
    "foodId": None,
    "name": ingredient.name,
    "image": first_entity_media(media_map, "ingredient", ingredient.id),
    "quantity": "0",
    "unit": ingredient.default_unit,
    "quantityTrackingMode": "track_quantity",
    "status": "out_of_stock",
    "displayStatus": "low_stock",
    "expiryDate": None,
    "daysUntilExpiry": None,
    "lowStockThreshold": decimal_text(
        ingredient.default_low_stock_threshold
    ),
    "purchaseDate": "",
    "storageLocation": ingredient.default_storage,
    "suggestedAction": "restock",
}
```

Deduplicate by `ingredientId` so an ingredient with a low positive batch is not also emitted as zero.

In `create_inventory_quick_draft_from_card()`, branch on
`matched_item["inventoryItemId"]`. For a null batch ID, allow only a
`sourceType == "ingredient"` restock action, re-read the Ingredient by
`family_id` and `ingredientId`, and build the restock operation from its
`default_unit`, `default_storage`, and low-stock threshold. Continue using
`require_inventory_item()` for consume, dispose, and batch-backed restock.
Do not expose `suggestedAction` on Food rows in this phase because that
endpoint creates only ingredient inventory drafts.

Use this zero-batch branch before the existing batch-backed branch:

```python
inventory_item_id = str(
    matched_item.get("inventoryItemId") or ""
).strip()
if not inventory_item_id:
    if (
        action != "restock"
        or matched_item.get("sourceType") != "ingredient"
    ):
        raise ValueError("该卡片项目不支持此库存操作")
    ingredient_id = str(
        matched_item.get("ingredientId") or ""
    ).strip()
    ingredient = db.scalar(
        select(Ingredient).where(
            Ingredient.family_id == family_id,
            Ingredient.id == ingredient_id,
        )
    )
    if ingredient is None:
        raise ValueError("食材不存在或不属于当前家庭")
    raw_operation = {
        "action": "restock",
        "ingredientId": ingredient.id,
        "inventoryItemId": None,
        "quantity": 1,
        "unit": ingredient.default_unit,
        "purchaseDate": today_for_family(
            family_id
        ).isoformat(),
        "storageLocation": ingredient.default_storage,
        "status": InventoryStatus.FRESH.value,
        "notes": "",
        "lowStockThreshold": float(
            ingredient.default_low_stock_threshold or 0
        ),
        "reason": "",
    }
else:
    inventory_item = require_inventory_item(
        db,
        family_id=family_id,
        inventory_item_id=inventory_item_id,
    )
    raw_operation = build_batch_backed_quick_operation(
        item=inventory_item,
        matched_item=matched_item,
        action=action,
        family_id=family_id,
    )
```

Extract the current batch-backed payload construction into
`build_batch_backed_quick_operation()` without changing its quantity rules.

- [ ] **Step 5: Mark focused reads as terminal inventory cards**

In `inventory-analysis/skill.yaml`, move these tools from `followup_required_tools` to `terminal_tools`:

```yaml
    inventory.read_expiring_items: 临期库存卡可作为临期查询的终态输出。
    inventory.read_expired_items: 过期库存卡可作为过期查询的终态输出。
    inventory.read_low_stock_items: 低库存卡可作为补货查询的终态输出。
    inventory.read_available_items: 可用库存卡可作为库存查询的终态输出。
```

Update each corresponding `ToolDefinition` to set:

```python
terminal_output=True,
output_types=["inventory_summary"],
```

Remove `requires_followup=True` for those four pure query tools. Keep draft-producing flows unchanged: the model may still call the same reads before generating an inventory operation draft.

- [ ] **Step 6: Run focused tests and commit**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_inventory_operations.py \
  backend/tests/ai_infra/test_skill_loader.py \
  backend/tests/ai_infra/test_tool_registry.py -q
npm --prefix frontend run test -- AiResultCards
```

Expected: all tests pass.

```bash
git add backend/app/ai/tools/catalog/inventory.py backend/app/services/ai_operations/experience.py backend/app/schemas/ai.py backend/app/ai/skills/catalog/inventory-analysis/skill.yaml backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_tool_registry.py frontend/src/api/types.ts frontend/src/components/ai/AiResultCards.test.tsx
git commit -m "fix: align AI inventory queries with card contract"
```

---

### Task 5: Remove Unsafe Defaults and Synchronize Documentation

**Files:**
- Modify: `backend/app/ai/skills/catalog/food-profile/SKILL.md`
- Modify: `docs/ai-assistant-standards.md`
- Modify: `backend/tests/ai_infra/test_skill_contract_repairs.py`

**Interfaces:**
- Consumes: current Food storage schema, which already permits an empty storage location.
- Produces: conservative Skill instructions and an accurate nine-Skill catalog document.

- [ ] **Step 1: Write failing documentation-contract tests**

Add to `backend/tests/ai_infra/test_skill_contract_repairs.py`:

```python
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[2]
ROOT_DIR = BACKEND_DIR.parent


def test_food_profile_does_not_default_unknown_stock_to_room_temperature() -> None:
    text = (BACKEND_DIR / "app/ai/skills/catalog/food-profile/SKILL.md").read_text(encoding="utf-8")

    assert "优先用 `常温` 作为可编辑默认值" not in text
    assert "保存位置不明确时留空或追问" in text


def test_ai_standards_lists_fixed_cooking_assistant_skill() -> None:
    text = (ROOT_DIR / "docs/ai-assistant-standards.md").read_text(encoding="utf-8")

    assert "cooking-assistant/" in text
    assert "只在 recipe_cook_page 固定 Profile" in text
```

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_repairs.py -q
```

Expected: both documentation assertions fail.

- [ ] **Step 3: Replace the unsafe Food storage rule**

In `food-profile/SKILL.md`, replace the current unknown-storage default with:

```markdown
- `storage_location` 仅用于成品、速食、包装食品库存，取值只能是 `冷藏`、`冷冻`、`常温`；用户没有明确说明且名称无法稳定判断保存条件时留空或追问，不要默认成 `常温`。只有包装明确、用户原话或已有真实资料能够支持时才填写保存位置。
```

- [ ] **Step 4: Document the ninth Skill and fixed profile boundary**

Add `cooking-assistant/` to the catalog tree in `docs/ai-assistant-standards.md`, followed by:

```markdown
`cooking_assistant` 只在 `recipe_cook_page` 固定 Profile 中使用，不属于主工作台允许动态注入的 8 个业务 Skill；它只读取做菜现场并提出 `ui.propose_actions`，不生成业务草稿。
```

- [ ] **Step 5: Run tests and commit**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_skill_contract_repairs.py \
  backend/tests/ai_infra/test_skill_loader.py -q
```

Expected: all tests pass.

```bash
git add backend/app/ai/skills/catalog/food-profile/SKILL.md docs/ai-assistant-standards.md backend/tests/ai_infra/test_skill_contract_repairs.py
git commit -m "docs: align AI skill safety and catalog contracts"
```

---

### Task 6: Phase 1 Regression Gate

**Files:**
- Modify only if a test exposes a regression in a Phase 1 file.

**Interfaces:**
- Consumes: all Phase 1 commits.
- Produces: a verified v2 baseline ready for the Contract v3 phase.

- [ ] **Step 1: Run AI infrastructure tests**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
```

Expected: all tests pass.

- [ ] **Step 2: Run backend regression tests**

```bash
npm run backend:test
```

Expected: all backend tests pass.

- [ ] **Step 3: Run frontend AI contract tests**

```bash
npm --prefix frontend run test -- src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiResultCards.test.tsx
```

Expected: all selected Vitest tests pass.

- [ ] **Step 4: Run static diff validation**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits successfully; status contains only intended Phase 1 files.

- [ ] **Step 5: Commit any regression-only corrections**

If verification required a correction in an already scoped Phase 1 file, commit it separately:

```bash
git add backend/app backend/tests docs/ai-assistant-standards.md
git commit -m "test: close AI skill phase one regressions"
```

If no correction was required, do not create an empty commit.

---

## Phase 1 Exit Criteria

- Shopping Skill can discover and reuse ready-like Food targets.
- Shopping read tools preserve `foodId` and `targetType`.
- All family-local date calculations use `Asia/Shanghai` rather than UTC date boundaries.
- Every provider call receives `timeContext`.
- All inventory query focuses return real `inventory_summary` cards.
- Low-stock output includes depleted configured ingredients.
- Unknown Food storage is not defaulted to `常温`.
- Documentation lists the actual nine loaded Skills and distinguishes the fixed cooking profile.
- Full backend tests and focused frontend AI contract tests pass.
