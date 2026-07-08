# Task 6 Report: AI Inventory Query Includes Food Stock

## Status

DONE

## Scope Delivered

- Updated `inventory.read_summary` to read from unified inventory overview so AI inventory summaries can include ready-made / instant / packaged food stock alongside ingredient inventory.
- Extended AI summary item shape so rows can identify `sourceType`, `foodId`, `ingredientId`, and `inventoryItemId`.
- Added `foodStockCount` to the summary payload and card data.
- Updated inventory and food-profile skill docs so food-stock reads are allowed in inventory queries, while food-stock writes still route through `food_profile` draft/approval instead of inventory write tools.
- Added a regression test covering ready-food stock visibility in AI inventory summary output.

## Files Changed

- `backend/app/ai/tools/catalog/inventory.py`
- `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`
- `backend/app/ai/skills/catalog/food-profile/SKILL.md`
- `backend/tests/ai_infra/test_inventory_operations.py`

## TDD Notes

1. Added `test_inventory_summary_includes_ready_food_stock`.
2. Ran the focused pytest target and confirmed it failed because `inventory.read_summary` only returned ingredient inventory.
3. Implemented the summary change through `build_inventory_overview(...)`.
4. Re-ran the focused pytest target and confirmed it passed.

## Verification

Executed:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_inventory_operations.py::AIInventoryOperationsTestCase::test_inventory_summary_includes_ready_food_stock -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_registry_and_metrics.py -q
backend/.venv/bin/python -m py_compile backend/app/ai/tools/catalog/inventory.py
```

Results:

- Focused inventory summary regression test: passed
- AI skill loader + registry/metrics suite: `38 passed, 108 subtests passed`
- Python compile/import check for updated tool module: passed

## Commit

- `89fba9e0` `feat: include food stock in AI inventory summaries`

## Self-Review

- Confirmed the change stays within Task 6 ownership files.
- Confirmed AI inventory summary reads now include food-stock rows without exposing any direct AI food-stock write tool.
- Confirmed skill guidance explicitly routes food-stock writes to `food_profile` draft/approval.

## Concerns

- None.

## Review Fix

### Changes

- Restored `inventory.read_summary` low-stock semantics to use real ingredient inventory threshold checks instead of inferring low stock from unified overview `tone`.
- Preserved ingredient-first summary priority by seeding overview cards with contextual ingredient expiring or low-stock records, then backfilling remaining slots from unified overview rows so ready-food stock still appears without displacing ingredient priorities.
- Removed overview-row `suggestedAction` exposure from `inventory.read_summary`; contextual tools (`inventory.read_expiring_items`, `inventory.read_low_stock_items`, `inventory.read_expired_items`) still expose their existing suggested actions.
- Updated `backend/app/ai/skills/catalog/food-profile/SKILL.md` frontmatter so it explicitly covers ready-made / instant / packaged food stock fields on food profiles while keeping ingredient inventory batches out of scope.
- Added AI regression coverage to assert overview food rows omit `suggestedAction` and summary low-stock count / ordering remain ingredient-driven when food rows coexist.

### Verification

Executed:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_inventory_operations.py::AIInventoryOperationsTestCase::test_inventory_summary_includes_ready_food_stock backend/tests/ai_infra/test_inventory_operations.py::AIInventoryOperationsTestCase::test_inventory_query_tools_expose_only_contextual_suggested_actions backend/tests/ai_infra/test_inventory_operations.py::AIInventoryOperationsTestCase::test_inventory_summary_preserves_low_stock_count_and_priority_for_ingredients -q
backend/.venv/bin/python -m py_compile backend/app/ai/tools/catalog/inventory.py
```

Results:

- `... [100%]`
- `3 passed in 1.23s`
- `py_compile`: passed
