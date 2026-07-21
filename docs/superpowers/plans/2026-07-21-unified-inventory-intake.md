# Unified AI Inventory Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep the approved specification open and stop if implementation would change a confirmed product decision.

**Goal:** Replace every model-visible stock-increasing path with one formal `inventory_intake.v1` Draft that atomically combines shopping-list fulfillment, direct inventory intake, and read-only ignored lines.

**Architecture:** `inventory_analysis` owns one resolver and one Draft Tool. The resolver converts receipt, image, and manual evidence into ready, blocked, missing-target, and ignored classifications; unresolved business questions use the existing `human.request_input`, and resolved lines enter the existing Draft/approval infrastructure. A generalized inventory-intake service executes shopping-linked and direct rows in one idempotent transaction, while the existing `/api/shopping-list/intakes` product endpoint becomes an adapter to that service.

**Tech Stack:** FastAPI, SQLAlchemy 2, Pydantic, MySQL, pytest, Culina Skill/Tool/Draft registries, React 18, TypeScript 5.7, Vitest, Testing Library, Vite, project CSS tokens, Playwright smoke checks.

**Approved design:** `docs/superpowers/specs/2026-07-21-unified-inventory-intake-design.md`

## Global Constraints

- Model-visible names are exactly `inventory.resolve_intake_lines`, `inventory.create_intake_draft`, `inventory_intake`, `inventory_intake.v1`, `inventory_intake.apply`, and `inventory_intake_editor`.
- Remove model-visible `shopping_intake`, `shopping.create_intake_draft`, both intake preview Tools, and `inventory_intake_candidates`. Do not add aliases for these unshipped AI contracts.
- Keep the non-AI `/api/shopping-list/intakes` request/response contract. It adapts to the generalized service and does not expose the removed AI contract.
- Do not modify generic Orchestrator, Runner, tool-loop retry, Draft lifecycle, approval lifecycle, or global progress/error rendering.
- Strictly reuse the existing Draft registry, approval panel, decision APIs, execution dispatch, stale handling, and result rendering. Do not add an intake-specific lifecycle, local approval store, or second run.
- `shopping_list` owns purchase planning, create/update/delete, and restore-to-pending. `inventory_analysis` owns every stock increase and all new `done=true` behavior.
- Every AI stock increase, including inventory-summary quick restock, creates `inventory_intake`; `inventory_operation` remains available only for `consume` and `dispose`. Do not introduce `inventory_operation.adjust`.
- The service uses one transaction, one `client_request_id`, one `InventoryOperation`, and all-or-nothing rollback for shopping-linked and direct rows.
- Preserve `InventoryOperationType.SHOPPING_INTAKE`, `InventoryConfirmationSource.SHOPPING_INTAKE`, database columns, and HTTP route names. This plan adds no migration.
- All reads/writes are constrained by current `family_id`. Request bodies never supply a trusted family, actor, role, refreshed version, or ownership decision.
- Lock in existing order: `InventoryOperation`, sorted Ingredient, sorted Food, sorted IngredientInventoryState, sorted InventoryItem when needed, sorted ShoppingListItem. Re-check ownership, version, pending state, unit, quantity, and identity after locking.
- Resolver codes `unit_not_supported`, `quantity_missing`, `quantity_unreliable`, `target_ambiguous`, `shopping_match_ambiguous`, `source_ambiguous`, `date_conflict`, `non_inventory_item`, and `target_missing` are successful read outputs, not exceptions.
- Date precedence is user-explicit date, receipt date, then `today_for_family(family_id)`. Explicit “today” conflicting with receipt date is a structured blocker.
- An extra purchase with one exact existing target and reliable quantity/unit defaults to `sourceKind=direct`, `action=stock_only`; it never creates or completes a shopping item.
- Missing Ingredient/Food targets use typed continuation through profile Skills. Approval success resumes `inventory_analysis`; rejection, conflict, or commit failure does not create an intake Draft.
- Draft identity/version fields are immutable. Only action, entered quantity/unit, package conversion, intake date, storage, expiry, status, notes, and `skip` are editable.
- Use simplified Chinese and distinguish “采购清单关联”“直接入库”“已忽略”. An ignored row is never described as needing confirmation.
- The custom editor renders no submit button; the existing approval container owns the single strongest primary action.
- Use canonical UI tokens from `frontend-ui-style`; do not add literal approximate colors or another card system. Independent controls are at least 44×44px; mobile/tablet inputs use 48px height.
- Verify at 375×812, 390×844, 430×932, 768×1024, 1024×768, and 1440×900. Report viewports actually inspected.
- Preserve unrelated worktree changes, stage explicit paths, use TDD, and end every task with a focused commit.

## Dependency Order

```text
0 baseline → 1 contracts → 2 atomic service → 3 formal Draft
→ 4 resolver → 5 Skills/continuation → 6 legacy removal
→ 7 approval editor → 8 frontend integration → 9 release gate
```

Do not deploy an intermediate commit. Old AI names intentionally have no compatibility layer, so cutover is safe only as one release.

## File Responsibility Map

### Backend create

- `backend/app/schemas/inventory_intake.py` — generalized request/result and product-adapter contracts.
- `backend/app/services/inventory_intake.py` — one idempotent mixed-row transaction.
- `backend/app/services/ai_operations/inventory_intake.py` — Draft normalize, approval validation, execution adapter.
- `backend/app/services/ai_operations/draft_specs/inventory_intake.py` — Draft registry metadata.
- `backend/tests/inventory/test_inventory_intake_service.py` — service contract/transaction coverage.
- `backend/tests/ai_infra/test_ai_inventory_intake.py` — resolver, Draft, Skill, approval, and cleanup coverage.

### Backend modify/delete

- Product adapter: `backend/app/api/shopping_intake.py`, `backend/app/schemas/inventory_operations.py`, `backend/tests/shopping/test_shopping_intake_api.py`.
- Replace `backend/app/services/shopping_intake.py` with the generalized service; update concurrency imports/tests.
- Replace AI files `services/ai_operations/shopping_intake.py` and `draft_specs/shopping_intake.py` with inventory-named files.
- Rework `backend/app/ai/tools/catalog/inventory_intake.py`; remove intake helpers/Tools from `catalog/shopping.py`.
- Update Tool/DTO schemas, Draft configs/registries, Skill manifests/docs, `state_schemas.py`, eval fixtures, and AI infra tests.
- Remove AI restock branches from inventory operation normalization/execution, composite handling, and quick-card routing.

### Frontend create/delete

- Create `frontend/src/components/ai/aiInventoryIntakeDraftModel.ts` and test.
- Create `frontend/src/components/ai/AiInventoryIntakeApproval.tsx`.
- Delete `frontend/src/components/ai/AiInventoryIntakeCandidates.tsx` and `AiShoppingIntakeApproval.tsx`.

### Frontend modify

- Update `frontend/src/api/types.ts`, `lib/aiWorkspaceContracts*`, `AiApprovalPanel*`, AI result-card/workspace dispatch, product-loop tests, inventory-operation editor/model, and `styles/09-ai-workspace.css`.

---

### Task 0: Capture the Executable Baseline

**Files:** No product changes.

**Interfaces:** Produces a green baseline and old-contract occurrence list.

- [ ] **Step 1: Confirm isolation and scope**

```bash
git status --short
git branch --show-current
git log -2 --oneline
git diff --name-status origin/main...HEAD
```

Expected: isolated feature branch/worktree; unrelated changes recorded and untouched.

- [ ] **Step 2: Capture old contract occurrences**

```bash
rg -n "shopping_intake|shopping\.create_intake_draft|shopping\.preview_intake_candidates|inventory\.preview_intake_candidates|inventory_intake_candidates|AiInventoryIntakeCandidates" backend/app backend/tests frontend/src
```

Expected: known AI contract plus product shopping-intake service/API/history occurrences. Save output for Task 9 classification.

- [ ] **Step 3: Run focused baseline**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_shopping_intake.py tests/ai_infra/test_inventory_operations.py tests/ai_infra/test_skill_contract_v3.py tests/shopping/test_shopping_intake_api.py -q
npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiProductLoopCards.test.tsx src/lib/aiWorkspaceContracts.test.ts
```

Expected: PASS. Record and resolve any pre-existing failure before using later output as regression evidence.

- [ ] **Step 4: Commit nothing**

Confirm `git status --short` is unchanged.

---

### Task 1: Add Generalized Intake Contracts

**Files:**

- Create: `backend/app/schemas/inventory_intake.py`
- Test: `backend/tests/inventory/test_inventory_intake_service.py`

**Interfaces:** Produces `InventoryIntakeItemRequest`, `InventoryIntakeRequest`, `InventoryIntakeItemResult`, `InventoryIntakeResult`, `shopping_request_to_inventory_request()`, and `inventory_result_to_shopping_result()`.

**Exact contract to implement:**

`InventoryIntakeItemRequest` has these fields and no others:

| Field | Type | Required rule |
|---|---|---|
| `line_id` | non-empty string, max 64 | always |
| `source_kind` | `shopping_item \| direct` | always |
| `action` | `stock_and_fulfill \| fulfill_without_stock \| stock_only` | always |
| `shopping_item_id` | string or null | shopping source only |
| `expected_shopping_item_row_version` | integer ≥ 1 or null | shopping source only |
| `target_kind` | `exact_ingredient \| presence_ingredient \| food \| none` | always |
| `target_id` | string or null | every stock action |
| `expected_ingredient_row_version` | integer ≥ 1 or null | Ingredient targets |
| `expected_food_row_version` | integer ≥ 1 or null | Food target |
| `state_id` | string or null | existing presence state only |
| `expected_state_row_version` | integer ≥ 1 or null | paired with `state_id` |
| `actual_quantity` | positive Decimal or null | exact Ingredient and Food stock actions |
| `unit` | string or null | exact Ingredient and Food stock actions |
| `resulting_availability_level` | `present_unknown \| low \| sufficient` or null | presence Ingredient stock action |
| `inventory_status` | existing `InventoryStatus` or null | Ingredient stock action |
| `expiry_date` | real `date` or null | stock action |
| `storage_location` | string or null | stock action; service validates non-empty |
| `notes` | string, max 500 | default empty |

Model-validation combinations are exact:

| Source/action | Shopping identity | Inventory target |
|---|---|---|
| `shopping_item + stock_and_fulfill` | required | required |
| `shopping_item + fulfill_without_stock` | required | forbidden; `target_kind=none` |
| `direct + stock_only` | forbidden | required |
| every other combination | rejected | rejected |

The request validator rejects duplicate `line_id`, duplicate non-null `shopping_item_id`, and more than 100 rows. The result row keeps `line_id` and optional `shopping_item_id`, so direct rows can be correlated without inventing a shopping ID.

`shopping_request_to_inventory_request()` performs a pure one-to-one mapping. `inventory_result_to_shopping_result()` accepts only `source_kind=shopping_item`, strips `line_id/source_kind`, maps `direct_stocked` as invalid input, and preserves all existing response fields. These adapters are covered separately from service behavior.

- [ ] **Step 1: Write failing Pydantic tests**

```python
def test_inventory_intake_accepts_shopping_and_direct_rows() -> None:
    request = InventoryIntakeRequest.model_validate({
        "client_request_id": "mixed-1",
        "intake_date": "2026-07-21",
        "items": [
            {"line_id": "eggs", "source_kind": "shopping_item", "action": "stock_and_fulfill", "shopping_item_id": "shopping-eggs", "expected_shopping_item_row_version": 2, "target_kind": "exact_ingredient", "target_id": "ingredient-eggs", "expected_ingredient_row_version": 3, "actual_quantity": "2", "unit": "个", "inventory_status": "fresh", "storage_location": "冷藏"},
            {"line_id": "milk", "source_kind": "direct", "action": "stock_only", "target_kind": "food", "target_id": "food-milk", "expected_food_row_version": 4, "actual_quantity": "1", "unit": "袋", "storage_location": "冷藏"},
        ],
    })
    assert [item.source_kind for item in request.items] == ["shopping_item", "direct"]


@pytest.mark.parametrize("source_kind,action", [
    ("direct", "stock_and_fulfill"),
    ("shopping_item", "stock_only"),
])
def test_inventory_intake_rejects_invalid_source_action(source_kind: str, action: str) -> None:
    row = {
        "line_id": "line-1",
        "source_kind": source_kind,
        "action": action,
        "target_kind": "food",
        "target_id": "food-milk",
        "expected_food_row_version": 1,
        "actual_quantity": "1",
        "unit": "袋",
        "storage_location": "冷藏",
    }
    if source_kind == "shopping_item":
        row.update({
            "shopping_item_id": "shopping-milk",
            "expected_shopping_item_row_version": 1,
        })
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate({
            "client_request_id": "invalid-combination",
            "intake_date": "2026-07-21",
            "items": [row],
        })
```

Add named tests for duplicate line IDs, duplicate shopping IDs, fulfill-only requiring `target_kind=none`, direct rows rejecting shopping identity, presence state ID/version pairing, positive exact/Food quantity, and invalid calendar dates.

The test file must contain these exact test functions so failures identify the violated contract directly:

```text
test_inventory_intake_accepts_shopping_and_direct_rows
test_inventory_intake_rejects_duplicate_line_ids
test_inventory_intake_rejects_duplicate_shopping_item_ids
test_direct_source_rejects_shopping_identity
test_direct_source_rejects_fulfill_action
test_shopping_source_rejects_stock_only
test_fulfill_without_stock_rejects_inventory_target
test_presence_target_requires_paired_state_identity_and_version
test_exact_and_food_targets_require_positive_quantity_and_unit
test_inventory_intake_rejects_invalid_calendar_date
test_shopping_request_adapter_preserves_every_business_field
test_inventory_result_adapter_rejects_direct_rows
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_intake_service.py -q
```

Expected: collection fails because `app.schemas.inventory_intake` does not exist.

- [ ] **Step 3: Implement exact discriminated rules**

```python
InventoryIntakeSourceKind = Literal["shopping_item", "direct"]
InventoryIntakeAction = Literal["stock_and_fulfill", "fulfill_without_stock", "stock_only"]
InventoryIntakeTargetKind = Literal["exact_ingredient", "presence_ingredient", "food", "none"]

class InventoryIntakeRequest(BaseModel):
    client_request_id: str = Field(min_length=1, max_length=120)
    intake_date: date
    items: list[InventoryIntakeItemRequest] = Field(min_length=1, max_length=100)

class InventoryIntakeResult(InventoryOperationResult):
    items: list[InventoryIntakeItemResult]
```

`InventoryIntakeItemRequest` contains line/source/action, optional shopping identity/version, target identity/version, optional state identity/version, actual quantity/unit, presence availability, status, expiry, storage, and notes. A model validator enforces Global Constraints. Field validators trim IDs/text; request validation rejects duplicate line/shopping IDs.

- [ ] **Step 4: Implement product adapters**

Map product `complete_without_inventory` to `fulfill_without_stock`; every other product row becomes shopping-linked `stock_and_fulfill`; `purchase_date` becomes `intake_date`; `line_id` is `shopping:{shopping_item_id}`. The reverse adapter rejects direct results and preserves existing ShoppingIntakeResult. Neither adapter queries the database.

- [ ] **Step 5: Verify green and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_intake_service.py -q
git add backend/app/schemas/inventory_intake.py backend/tests/inventory/test_inventory_intake_service.py
git commit -m "Add generalized inventory intake contracts"
```

### Task 2: Generalize the Atomic Intake Service

**Files:**

- Create: `backend/app/services/inventory_intake.py`
- Delete: `backend/app/services/shopping_intake.py`
- Modify: `backend/app/api/shopping_intake.py`
- Modify: `backend/app/services/inventory_operation_locking.py`
- Modify: `backend/tests/inventory/test_inventory_intake_service.py`
- Modify: `backend/tests/shopping/test_shopping_intake_api.py`
- Modify: `backend/tests/inventory/test_inventory_mysql_concurrency.py`

**Interfaces:** Produces `InventoryIntakeValidationError`, `validation_detail()`, and `apply_inventory_intake(db, *, family_id, user_id, request, business_date, user_role)`. Preserves the public shopping HTTP contract and persisted operation/history types.

**Internal service structure:**

Move reusable helpers from `shopping_intake.py` into `inventory_intake.py`, rename shopping-specific helpers, and keep the file organized in this order:

| Unit | Exact responsibility |
|---|---|
| `InventoryIntakeValidationError` | stores `code`, `message`, `field_errors`, and `conflicts` |
| `validation_detail(error)` | returns those four fields as JSON-safe data |
| `_field_error(line_id, shopping_item_id, field, code, message)` | creates one line-correlated field error |
| `_raise_validation` | raises the structured exception with one field error |
| `convert_actual_to_planned_unit` | existing Ingredient unit conversion for partial-purchase math |
| `_load_operation_with_lines(db, operation_id)` | reloads idempotent operation and ordered lines |
| `_result_from_operation(operation, user_id, user_role)` | reconstructs mixed row results on replay |
| `_resolve_target_ids(request)` | returns shopping, Ingredient, Food, required-state, optional-state ID collections |
| `_ensure_manual_expiry` | preserves existing manual-expiry requirement |
| `apply_inventory_intake` | performs the complete validation/mutation transaction |

Use a preparation object so validation finishes before the first mutation:

```python
@dataclass(slots=True)
class _PreparedIntakeItem:
    request_item: InventoryIntakeItemRequest
    shopping: ShoppingListItem | None = None
    ingredient: Ingredient | None = None
    food: Food | None = None
    state: IngredientInventoryState | None = None
    shopping_before_snapshot: dict[str, object] | None = None
    ingredient_before_version: int | None = None
    food_before_snapshot: dict[str, object] | None = None
    state_before_snapshot: dict[str, object] | None = None
    is_free_text_shopping: bool = False
```

**Pre-mutation validation matrix:**

| Target/action | Required checks |
|---|---|
| shopping row | shopping exists in family, exact row version, `done=false`, bound target matches unless free-text |
| exact Ingredient | target exists, tracks quantity, exact Ingredient version, supported/convertible unit, positive quantity, manual expiry rule, expiry ≥ intake date |
| presence Ingredient | target exists, does not track quantity, Ingredient version, state identity/version pair matches locked state, resulting availability is not absent, expiry rule |
| Food | current-family ready-made/instant/packaged Food, Food version, quantity precision, actual unit equals non-empty existing stock unit when stock > 0, expiry ≥ intake date |
| fulfill without stock | shopping validation only; no inventory target or inventory mutation |
| direct row | no ShoppingListItem lookup, mutation still uses the same target/version validation |

Duplicate targets are handled deliberately: multiple exact Ingredient rows may create multiple physical batches; duplicate presence Ingredient and duplicate Food targets are rejected because each mutates one aggregate row and would make version/snapshot meaning ambiguous.

**Mutation and history rules:**

- Exact Ingredient calls `create_inventory_batch()` and records one `INVENTORY_ITEM` line plus one Ingredient collection guard.
- Presence Ingredient calls the existing `upsert_inventory_state` with `confirmation_source=SHOPPING_INTAKE` and `record_activity=False`, then records create/update state line plus Ingredient guard.
- Food calls the existing `apply_food_stock_intake` with `record_activity=False`, then records one Food update line.
- Shopping rows record one ShoppingListItem update line after inventory mutation; partial quantity keeps `done=false` and writes remaining planned quantity.
- Direct rows return `result=direct_stocked` and never write a ShoppingListItem operation line.
- Fulfill-only rows return `completed_without_inventory` and write only ShoppingListItem history.
- Result order matches request order even though target locks are sorted.
- Idempotent replay reconstructs direct and shopping result rows from operation-line metadata; therefore target history lines must include `line_id` and `source_kind` metadata.
- Summary counts stock rows, fully completed shopping rows, and partial shopping rows separately. Activity logging occurs once after all rows succeed.

The service never calls `db.commit()`. The current API and AI approval application transaction boundaries remain the only commit owners.

- [ ] **Step 1: Add failing mixed-transaction tests**

```python
def test_mixed_intake_stocks_shopping_and_direct_rows_in_one_operation(context) -> None:
    request = InventoryIntakeRequest.model_validate({
        "client_request_id": "mixed-receipt-1",
        "intake_date": "2026-07-21",
        "items": [
            {
                "line_id": "eggs",
                "source_kind": "shopping_item",
                "action": "stock_and_fulfill",
                "shopping_item_id": context.egg_shopping.id,
                "expected_shopping_item_row_version": context.egg_shopping.row_version,
                "target_kind": "exact_ingredient",
                "target_id": context.egg_ingredient.id,
                "expected_ingredient_row_version": context.egg_ingredient.row_version,
                "actual_quantity": "2",
                "unit": "个",
                "inventory_status": "fresh",
                "storage_location": "冷藏",
            },
            {
                "line_id": "milk",
                "source_kind": "direct",
                "action": "stock_only",
                "target_kind": "food",
                "target_id": context.milk_food.id,
                "expected_food_row_version": context.milk_food.row_version,
                "actual_quantity": "1",
                "unit": "袋",
                "storage_location": "冷藏",
            },
        ],
    })
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["stocked", "direct_stocked"]
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is True
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("1")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 1
```

Add named tests for direct exact Ingredient, direct presence Ingredient, direct Food, fulfill-without-stock, partial shopping quantity, same-key replay, same-key/different-payload conflict, shopping/Ingredient/Food stale, cross-family target, duplicate presence/Food target, and injected failure after first mutation rolling back everything.

Create one module fixture named `context` with these concrete objects: current Family/User/Member, `egg_ingredient` tracking quantity in 个, pending `egg_shopping` bound to it, `milk_food` of type packaged with stock unit 袋, one presence-only Ingredient/state, and an `other_family` copy of each target type. Flush before yielding so every expected row version is real. The fixture exposes only those objects and `db`; it does not hide request construction in helper methods.

Use these exact test names:

```text
test_direct_exact_ingredient_creates_batch_without_shopping_change
test_direct_presence_ingredient_updates_state_without_shopping_change
test_direct_food_increases_stock_without_shopping_change
test_fulfill_without_stock_completes_only_shopping_item
test_mixed_intake_stocks_shopping_and_direct_rows_in_one_operation
test_partial_purchase_updates_remaining_quantity
test_same_request_id_same_hash_replays_original_result
test_same_request_id_different_hash_conflicts
test_shopping_version_conflict_rolls_back_every_row
test_ingredient_version_conflict_rolls_back_every_row
test_food_version_conflict_rolls_back_every_row
test_cross_family_target_is_rejected_before_mutation
test_duplicate_presence_target_is_rejected
test_duplicate_food_target_is_rejected
test_failure_after_first_row_rolls_back_inventory_shopping_history_and_activity
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_intake_service.py -q
```

Expected: collection fails because `app.services.inventory_intake` does not exist.

- [ ] **Step 3: Move and generalize the transaction**

Expose:

```python
def apply_inventory_intake(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: InventoryIntakeRequest,
    business_date: date,
    user_role: UserRole = UserRole.MEMBER,
) -> InventoryIntakeResult:
    """Validate and mutate one complete intake operation; never commit."""
```

Algorithm:

1. Canonical-hash the whole request and claim one per-family operation.
2. Collect all target IDs; direct rows contribute no shopping ID and fulfill-only rows contribute no inventory target.
3. Call `lock_inventory_targets()` once in the existing stable order.
4. Re-check family, expected versions, pending state, target identity, tracking mode, quantity, unit, date, and storage for every row before mutation.
5. Reuse `create_inventory_batch`, `upsert_inventory_state`, and `apply_food_stock_intake` with `record_activity=False`.
6. Preserve shopping partial/complete behavior. Direct rows write no ShoppingListItem line.
7. Record snapshots and one Ingredient collection guard per touched Ingredient.
8. Build one summary/activity and return one result; never commit inside the service.

Expected business validation uses `InventoryIntakeValidationError` with `line_id`, optional `shopping_item_id`, field, code, and message.

- [ ] **Step 4: Adapt the existing shopping endpoint**

```python
inventory_request = shopping_request_to_inventory_request(payload)
inventory_result = apply_inventory_intake(
    db,
    family_id=membership.family_id,
    user_id=current_user.id,
    user_role=membership.role,
    business_date=today_for_family(membership.family_id),
    request=inventory_request,
)
result = inventory_result_to_shopping_result(inventory_result)
```

Update imports/errors and delete the old service module rather than keeping an internal alias.

The HTTP route remains responsible for translating errors:

- Pydantic request errors keep the existing structured `422` detail contract.
- `InventoryIntakeValidationError` maps to the existing structured `422` response.
- `InventoryConflictError` and idempotency hash conflict keep the existing `409` response.
- Successful response is still serialized as `ShoppingIntakeResult`; no direct row can reach this public endpoint.

- [ ] **Step 5: Update MySQL concurrency and verify**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_intake_service.py tests/shopping/test_shopping_intake_api.py tests/inventory/test_inventory_operation_revert.py -q
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py -q
```

Expected: service/API/revert tests pass; MySQL mixed-lock test has no deadlock and stale loser writes nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/inventory_intake.py backend/app/services/inventory_intake.py backend/app/api/shopping_intake.py backend/app/services/inventory_operation_locking.py backend/tests/inventory/test_inventory_intake_service.py backend/tests/shopping/test_shopping_intake_api.py backend/tests/inventory/test_inventory_mysql_concurrency.py
git rm backend/app/services/shopping_intake.py
git commit -m "Generalize atomic inventory intake service"
```

---

### Task 3: Replace the AI Draft Contract with `inventory_intake.v1`

**Files:**

- Create: `backend/app/services/ai_operations/inventory_intake.py`
- Create: `backend/app/services/ai_operations/draft_specs/inventory_intake.py`
- Delete: `backend/app/services/ai_operations/shopping_intake.py`
- Delete: `backend/app/services/ai_operations/draft_specs/shopping_intake.py`
- Modify: `backend/app/services/ai_operations/draft_specs/common.py`
- Modify: `backend/app/services/ai_operations/registry_specs.py`
- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Replace: `backend/tests/ai_infra/test_ai_shopping_intake.py` with `test_ai_inventory_intake.py`.

**Interfaces:** Produces normalize, immutable approval validation, execution adapter, and registry spec for the exact new names.

**Exact Draft shape:**

```json
{
  "draftType": "inventory_intake",
  "schemaVersion": "inventory_intake.v1",
  "clientRequestId": "ai-inventory-intake-example",
  "sourceType": "receipt_image",
  "sourceReference": {"mediaId": "media_xxx"},
  "intakeDate": "2026-07-21",
  "intakeDateSource": "receipt",
  "items": [
    {
      "lineId": "line-1",
      "sourceLineId": "receipt-1",
      "sourceText": "鸡蛋 2个",
      "sourceKind": "shopping_item",
      "action": "stock_and_fulfill",
      "shoppingItemId": "shopping_xxx",
      "title": "鸡蛋",
      "expectedShoppingItemRowVersion": 2,
      "targetKind": "exact_ingredient",
      "targetId": "ingredient_xxx",
      "expectedIngredientRowVersion": 4,
      "expectedFoodRowVersion": null,
      "stateId": null,
      "expectedStateRowVersion": null,
      "plannedQuantity": "2",
      "plannedUnit": "个",
      "enteredQuantity": "2",
      "enteredUnit": "个",
      "packageConversion": null,
      "actualQuantity": "2",
      "actualUnit": "个",
      "inventoryStatus": "fresh",
      "resultingAvailabilityLevel": null,
      "expiryDate": null,
      "storageLocation": "冷藏",
      "notes": "",
      "before": {},
      "impact": {}
    }
  ],
  "ignoredItems": [
    {
      "sourceLineId": "receipt-4",
      "sourceText": "垃圾袋 1个",
      "displayName": "垃圾袋",
      "reasonCode": "non_inventory_item",
      "reason": "非食品库存对象，本次不会入库"
    }
  ],
  "summary": {}
}
```

The model supplies intent fields only: source evidence, line/source text, source kind, action, target/shopping IDs returned by resolver, entered values, and editable inventory details. The normalizer overwrites names, planned values, canonical actual values, expected versions, before snapshots, impact, and summary from real rows.

**Two normalization phases:**

- `phase=draft`: re-read all identities, reject any blocker marker, calculate canonical quantity, stamp versions/snapshots, and generate a new stable request ID.
- `phase=approval`: preserve original immutable values supplied by the approval record, validate editable values, recalculate canonical quantity/impact without refreshing versions, and reject protected-field changes through `validate_inventory_intake_approval_value()`.

Changing `intakeDate` is allowed, but approval normalization must recompute default expiry and date-range validation using that submitted date. It must not change `intakeDateSource`, because source provenance is historical evidence.

- [ ] **Step 1: Write failing registry/Draft tests**

```python
def test_registry_exposes_only_inventory_intake_draft() -> None:
    assert draft_operation_registry.supports("inventory_intake")
    assert not draft_operation_registry.supports("shopping_intake")
    definition = build_workspace_tool_registry().get("inventory.create_intake_draft")
    assert definition.draft_types == ["inventory_intake"]
```

Add shopping-linked, direct, ignored, mixed, immutable-field, editable-field, all-skip, execution, approval type, and widget tests.

Use exact tests:

```text
test_registry_exposes_only_inventory_intake_draft
test_normalizer_stamps_shopping_target_and_versions
test_normalizer_stamps_direct_food_target_and_versions
test_normalizer_keeps_ignored_items_read_only
test_normalizer_rejects_ambiguous_or_unresolved_rows
test_approval_allows_action_quantity_date_storage_expiry_status_and_notes
test_approval_rejects_source_identity_target_version_and_before_changes
test_approval_rejects_added_or_removed_rows
test_executor_filters_skip_and_calls_service_once
test_executor_rejects_all_skip
test_inventory_intake_approval_uses_new_type_schema_and_widget
test_old_shopping_intake_draft_is_not_registered
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_inventory_intake.py -q
```

Expected: FAIL because only the old Draft is registered.

- [ ] **Step 3: Define the exact Draft schema**

Top-level required fields: `draftType`, `schemaVersion`, `sourceType`, `intakeDate`, `intakeDateSource`, `items`, and `ignoredItems`. Source types are `manual_text|receipt_image|receipt_text|inventory_photo|gift|reconciliation|initial_inventory|historical_entry`. Draft item actions include service actions plus `skip`. Remove `matchLevel` and `unmatchedCandidates`: blockers do not enter approval.

Define `INVENTORY_INTAKE_ITEM_SCHEMA` and `INVENTORY_INTAKE_IGNORED_ITEM_SCHEMA` next to the top-level schema; set `additionalProperties=False` at all three levels. The Tool input accepts no backend-stamped expected-version/before fields as required model inputs, but the output schema includes them after normalization. Reuse the existing `draft_input_schema()`/`draft_output_schema()` wrappers instead of adding new Tool transport logic.

- [ ] **Step 4: Implement normalization and immutable boundaries**

Normalizer re-reads current-family shopping items, Ingredients, states, and Foods; stamps names, planned values, before snapshots, and versions; accepts mixed source kinds; creates `ai-inventory-intake-*`; and normalizes ignored rows read-only.

Protect top-level `clientRequestId,sourceType,sourceReference,intakeDateSource,ignoredItems` and per-row `lineId,sourceLineId,sourceText,sourceKind,shoppingItemId,expectedShoppingItemRowVersion,targetKind,targetId,expectedIngredientRowVersion,expectedFoodRowVersion,stateId,expectedStateRowVersion,plannedQuantity,plannedUnit,before`. Rows cannot be added/deleted; use `skip`.

- [ ] **Step 5: Implement one service execution**

Filter skip rows, reject an empty executable set, map camelCase to `InventoryIntakeRequest`, call `apply_inventory_intake()` once, and return the InventoryOperation as the business entity. Do not split shopping/direct rows.

Executor mapping is explicit:

| Draft | Service request |
|---|---|
| `lineId` | `line_id` |
| `sourceKind` | `source_kind` |
| `shoppingItemId` | `shopping_item_id` |
| `expectedShoppingItemRowVersion` | `expected_shopping_item_row_version` |
| `targetKind` / `targetId` | `target_kind` / `target_id` |
| expected target/state versions | same snake_case fields |
| `actualQuantity` / `actualUnit` | `actual_quantity` / `unit` |
| `resultingAvailabilityLevel` | `resulting_availability_level` |
| `inventoryStatus` | `inventory_status` |
| `expiryDate`, `storageLocation`, `notes` | snake_case equivalents |

`intakeDate` maps to `InventoryIntakeRequest.intake_date`; `clientRequestId` maps unchanged. `ignoredItems` and `skip` rows never reach the service.

- [ ] **Step 6: Register approval metadata**

```python
"inventory_intake": {
    "value_key": "draft",
    "widget": "inventory_intake_editor",
    "approval_type": "inventory_intake.apply",
    "operation_type": "inventory_intake.apply",
    "business_entity_type": "InventoryOperation",
    "title": "确认入库",
    "instruction": "确认后会统一登记库存，并按草稿更新关联采购项。",
    "approve_label": "确认入库",
    "reject_label": "暂不处理",
}
```

Delete old Draft/widget DTO literals; never accept both.

- [ ] **Step 7: Verify and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_inventory_intake.py tests/ai_infra/test_registry_and_metrics.py tests/ai_infra/test_workspace_approvals.py -q
git add backend/app/services/ai_operations/inventory_intake.py backend/app/services/ai_operations/draft_specs/inventory_intake.py backend/app/services/ai_operations/draft_specs/common.py backend/app/services/ai_operations/registry_specs.py backend/app/ai/tools/schemas.py backend/app/schemas/ai.py backend/tests/ai_infra/test_ai_inventory_intake.py backend/tests/ai_infra/test_registry_and_metrics.py backend/tests/ai_infra/test_workspace_approvals.py
git rm backend/app/services/ai_operations/shopping_intake.py backend/app/services/ai_operations/draft_specs/shopping_intake.py backend/tests/ai_infra/test_ai_shopping_intake.py
git commit -m "Replace shopping intake with inventory intake draft"
```

---

### Task 4: Implement the Unified Resolver Tool

**Files:**

- Modify: `backend/app/ai/tools/catalog/inventory_intake.py`
- Modify: `backend/app/ai/tools/catalog/shopping.py`
- Modify: `backend/tests/ai_infra/test_ai_inventory_intake.py`
- Modify: `backend/tests/ai_infra/test_product_closed_loops.py`

**Interfaces:** Produces `resolve_intake_lines(context, payload)` and `inventory_intake_create_draft(context, payload)`; reuses purchasable resolution, pending shopping rows, unit helpers, family date, and Task 3 normalizer.

**Resolver input contract:**

```json
{
  "sourceType": "receipt_text",
  "purchaseIntent": "purchase",
  "dateEvidence": {
    "userDate": null,
    "userSaidToday": false,
    "receiptDate": "2026-07-21"
  },
  "lines": [
    {
      "sourceLineId": "receipt-1",
      "rawText": "鸡蛋 2个",
      "name": "鸡蛋",
      "quantity": "2",
      "unit": "个",
      "confidence": 0.98,
      "itemKind": "inventory",
      "targetHint": "ingredient",
      "shoppingItemId": null,
      "targetId": null
    }
  ]
}
```

- `purchaseIntent` is `purchase|non_purchase|unknown` and comes from explicit user/source semantics.
- `shoppingItemId`/`targetId` are accepted only when copied from a prior resolver result and confirmed through human input; the resolver always revalidates them by family and current state.
- `confidence < 0.8` with a supplied quantity is `quantity_unreliable`; missing quantity for exact/Food is `quantity_missing`.
- `itemKind=non_inventory` is model evidence used only to classify an ignored row; the ignored classification remains visible in the final Draft.

**Resolver output record shapes:**

```python
ready_line = {
    "sourceLineId": str,
    "sourceText": str,
    "sourceKind": "shopping_item" | "direct",
    "shoppingItem": dict | None,
    "target": dict,
    "targetKind": "exact_ingredient" | "presence_ingredient" | "food",
    "enteredQuantity": str | None,
    "enteredUnit": str | None,
    "defaultAction": "stock_and_fulfill" | "stock_only",
    "matchReason": str,
}
blocked_line = {
    "sourceLineId": str,
    "sourceText": str,
    "reasonCode": str,
    "question": str,
    "options": list[dict],
    "resumeHint": dict,
}
missing_line = {
    "sourceLineId": str,
    "sourceText": str,
    "targetHint": "ingredient" | "food",
    "reasonCode": "target_missing",
    "recommendedActions": ["create_profile", "skip"],
}
ignored_line = {
    "sourceLineId": str,
    "sourceText": str,
    "displayName": str,
    "reasonCode": "non_inventory_item",
    "reason": str,
}
```

Every option ID is a real current-family entity ID. Output preserves input order inside each classification and includes counts only in `summary`.

**Reason-code behavior:**

| Code | Resolver data | Skill next action |
|---|---|---|
| `shopping_match_ambiguous` | real pending candidates | choose shopping item |
| `source_ambiguous` | same-name pending item plus direct option | choose shopping-linked or direct |
| `target_ambiguous` | real Ingredient/Food candidates | choose target |
| `unit_not_supported` | entered unit, supported units, target | choose supported unit/conversion/fulfill-only/skip |
| `quantity_missing` | target and required unit | ask positive quantity |
| `quantity_unreliable` | recognized quantity/confidence | confirm or replace quantity |
| `date_conflict` | user and receipt dates | choose one date |
| `target_missing` | target hint | profile continuation or skip |
| `non_inventory_item` | explanation | no question; keep ignored |

- [ ] **Step 1: Add failing reported-scenario test**

```python
def test_resolver_classifies_reported_receipt(context) -> None:
    result = resolve_intake_lines(context.tool_context, {
        "sourceType": "receipt_text",
        "purchaseIntent": "purchase",
        "dateEvidence": {"receiptDate": "2026-07-21"},
        "lines": [
            {"sourceLineId": "milk", "rawText": "牛奶 1袋", "name": "牛奶", "quantity": "1", "unit": "袋", "itemKind": "inventory"},
            {"sourceLineId": "eggs", "rawText": "鸡蛋 2个", "name": "鸡蛋", "quantity": "2", "unit": "个", "itemKind": "inventory"},
            {"sourceLineId": "salmon", "rawText": "三文鱼 0.268公斤", "name": "三文鱼", "quantity": "0.268", "unit": "公斤", "itemKind": "inventory"},
            {"sourceLineId": "bags", "rawText": "垃圾袋 1个", "name": "垃圾袋", "quantity": "1", "unit": "个", "itemKind": "non_inventory"},
        ],
    })
    assert [row["sourceLineId"] for row in result["readyLines"]] == ["milk", "eggs"]
    assert [row["sourceKind"] for row in result["readyLines"]] == ["direct", "shopping_item"]
    assert result["needsResolution"][0]["reasonCode"] == "unit_not_supported"
    assert result["ignoredItems"][0]["sourceLineId"] == "bags"
```

Add tests for missing/unreliable quantity, multiple shopping/target matches, explicit non-purchase, unknown source with pending match, missing target, date conflict, invalid date, cross-family selected ID, and input order.

Use exact test names:

```text
test_resolver_classifies_reported_receipt
test_resolver_returns_quantity_missing_for_exact_target
test_resolver_returns_quantity_unreliable_below_confidence_threshold
test_resolver_returns_real_pending_candidates_for_duplicate_name
test_resolver_returns_real_target_candidates_for_ambiguous_name
test_non_purchase_source_does_not_touch_same_name_pending_item
test_unknown_source_with_pending_item_requires_source_choice
test_exact_extra_purchase_defaults_to_direct_stock_only
test_missing_target_recommends_profile_or_skip
test_user_today_and_different_receipt_date_returns_conflict
test_invalid_calendar_date_is_rejected_as_input_contract_error
test_selected_cross_family_ids_are_rejected
test_resolver_preserves_source_line_order
test_unit_not_supported_is_output_not_tool_failure
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_inventory_intake.py -k resolver -q
```

Expected: FAIL because old candidate preview throws unit errors.

- [ ] **Step 3: Implement exact output**

Return exactly `readyLines,needsResolution,missingTargets,ignoredItems,dateResolution,summary`. No result-card wrapper, selected flag, card ID, or terminal metadata.

Matching order: validated prior selection → pending shopping exact/unique suggestion → bound target → direct purchasable exact target → blocker/missing. Unit, quantity, source, and date problems become reason-coded objects. `itemKind=non_inventory` goes only to ignored rows.

Implement focused helpers in `inventory_intake.py` so the main handler stays readable:

| Function | Exact responsibility |
|---|---|
| `_normalize_source_line(raw, index)` | trim/cap text, parse positive Decimal, assign stable sourceLineId, preserve confidence/item kind |
| `_resolve_intake_date(family_id, evidence)` | strict real-date parsing, precedence, conflict options, family-date fallback |
| `_load_pending_shopping(db, family_id)` | return current-family `done=false` rows in stable updated/id order |
| `_match_pending_item(line, pending)` | validate explicit selection, then exact name, then unique containment, otherwise ambiguity/unmatched |
| `_resolve_inventory_target(context, line)` | use bound target or existing purchasable resolution and serialize real unit/tracking/storage facts |
| `_validate_target_quantity_unit(line, target)` | return ready canonical fields or one structured quantity/unit blocker |
| `resolve_intake_lines(context, payload)` | orchestrate helpers and assemble the six top-level output fields |

Each helper is covered through the named handler-level tests above. Keep these helpers in the Tool module; do not add a second read-service abstraction for this one resolver.

- [ ] **Step 4: Register new Tools and remove old Tools**

Register `inventory.resolve_intake_lines` as read/requires-followup and `inventory.create_intake_draft` as Draft for `inventory_intake`. Delete `inventory.preview_intake_candidates`, `shopping.preview_intake_candidates`, and `shopping.create_intake_draft`.

- [ ] **Step 5: Verify and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_inventory_intake.py tests/ai_infra/test_product_closed_loops.py -q
git add backend/app/ai/tools/catalog/inventory_intake.py backend/app/ai/tools/catalog/shopping.py backend/tests/ai_infra/test_ai_inventory_intake.py backend/tests/ai_infra/test_product_closed_loops.py
git commit -m "Add unified inventory intake resolver"
```

### Task 5: Cut Over Skill Ownership and Typed Continuation

**Files:**

- Modify: `backend/app/ai/skills/state_schemas.py`
- Modify: `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/shopping-list/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/shopping-list/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/shopping-list/references/workflows.md`
- Modify: `backend/tests/ai_infra/test_skill_contract_v3.py`
- Modify: `backend/tests/ai_infra/test_skill_contract_repairs.py`
- Modify: `backend/tests/ai_infra/test_ai_inventory_intake.py`
- Modify: `backend/tests/ai_evals/cases/core.jsonl`
- Modify: `backend/tests/ai_evals/test_eval_dataset.py`

**Interfaces:** Produces `inventory_intake_missing_target.v1` and the stable planning-vs-inventory boundary.

**Target `inventory-analysis/skill.yaml` contract:**

```yaml
allowed_tools:
  - ingredient.search
  - ingredient.read_by_id
  - ingredient.resolve_candidates
  - food.search
  - food.read_by_id
  - shopping.read_pending
  - shopping.read_by_id
  - inventory.read_summary
  - inventory.read_expiring_items
  - inventory.read_expired_items
  - inventory.read_low_stock_items
  - inventory.read_available_items
  - inventory.resolve_intake_lines
  - human.request_input
  - workspace.read_artifact
  - inventory.create_intake_draft
  - inventory.create_operation_draft
draft_types:
  - inventory_intake
  - inventory_operation
draft_contract:
  inventory_intake:
    schema_version: inventory_intake.v1
    approval_config_key: inventory_intake
    commit_handler_key: inventory_intake
  inventory_operation:
    schema_version: inventory_operation.v1
    approval_config_key: inventory_operation
    commit_handler_key: inventory_operation
```

Do not keep `inventory.create_unit_conversion_operation_draft`; once all intake uses the new Draft, a confirmed one-time conversion is expressed as `packageConversion` on an intake row. Long-term unit saving still hands off to `ingredient_profile` and resumes intake.

The manifest has no intake output card. Inventory query cards remain terminal reads. Resolver is `followup_required`: it must lead to human input, profile handoff, a formal Draft, or a textual explanation when every row was ignored/skipped.

**Human input contract for one blocker:**

```json
{
  "question": "三文鱼按公斤识别，但当前库存单位是块。这次要怎样处理？",
  "inputMode": "choice",
  "options": [
    {"id": "convert_once", "label": "提供本次换算"},
    {"id": "fulfill_without_stock", "label": "只完成采购项，不入库"},
    {"id": "skip", "label": "本次跳过"}
  ],
  "allowMultiple": false,
  "required": true,
  "sourceSkills": ["inventory_analysis"],
  "resumeHint": {
    "questionType": "inventory_intake_resolution",
    "sourceLineId": "salmon",
    "reasonCode": "unit_not_supported",
    "unsupportedUnit": "公斤",
    "supportedUnits": ["块"]
  }
}
```

On resume, merge only the answer for that `sourceLineId`, call resolver again with all original lines, and process the next blocker. Do not store a generated Draft inside `resumeHint`.

- [ ] **Step 1: Write failing Skill assertions**

```python
def test_inventory_skill_owns_intake_and_shopping_skill_does_not() -> None:
    registry = build_workspace_skill_registry()
    inventory = registry.get("inventory_analysis").manifest
    shopping = registry.get("shopping_list").manifest
    assert "inventory.resolve_intake_lines" in inventory.tools
    assert "inventory.create_intake_draft" in inventory.tools
    assert inventory.draft_contract["inventory_intake"].schema_version == "inventory_intake.v1"
    assert "shopping.preview_intake_candidates" not in shopping.tools
    assert "shopping.create_intake_draft" not in shopping.tools
    assert "shopping_intake" not in shopping.draft_types
```

Add strict continuation tests for valid mixed state, invalid calendar date, >30 lines, and extra fields.

Use exact state tests:

```text
test_inventory_intake_missing_target_state_round_trips_json
test_inventory_intake_missing_target_state_rejects_invalid_calendar_date
test_inventory_intake_missing_target_state_rejects_more_than_thirty_pending_lines
test_inventory_intake_missing_target_state_rejects_row_versions_and_extra_fields
test_old_shopping_to_stock_state_is_removed
test_old_ready_food_stock_handoff_state_is_removed
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_skill_contract_v3.py tests/ai_infra/test_skill_contract_repairs.py tests/ai_infra/test_ai_inventory_intake.py -q
```

Expected: FAIL because old manifests still advertise candidate/shopping intake.

- [ ] **Step 3: Add typed restoration state**

```python
class InventoryIntakeContinuationLine(ContinuationStateModel):
    sourceLineId: EntityId
    rawText: ShortText
    name: ShortText
    quantity: QuantityText | None = None
    unit: ShortText | None = None
    itemKind: Literal["inventory", "non_inventory"]
    targetHint: Literal["ingredient", "food"] | None = None
    shoppingItemId: EntityId | None = None
    targetId: EntityId | None = None

class InventoryIntakeMissingTargetState(ContinuationStateModel):
    sourceType: Literal["manual_text", "receipt_image", "receipt_text", "inventory_photo", "gift", "reconciliation", "initial_inventory", "historical_entry"]
    purchaseIntent: Literal["purchase", "non_purchase", "unknown"]
    intakeDate: IsoDate
    intakeDateSource: Literal["user", "receipt", "family_business_date"]
    currentLine: InventoryIntakeContinuationLine
    pendingLines: Annotated[list[InventoryIntakeContinuationLine], Field(max_length=30)]
    resolvedLines: Annotated[list[InventoryIntakeContinuationLine], Field(max_length=30)]
```

Register `inventory_intake_missing_target.v1`. Preserve evidence/user-confirmed IDs, never row versions or executable Draft snapshots. Remove `ShoppingToStockState` and `shopping_to_stock.v1`.

Also remove the inventory Skill’s `ready_food_stock` handoff and `ReadyFoodStockState` / `ready_food_stock.v1`. Existing ready-like Food is now a normal resolver target; missing ready-like Food uses the new intake missing-target continuation through `food_profile` and resumes `inventory_analysis`.

- [ ] **Step 4: Rewrite inventory Skill**

Manifest allows resolver, new Draft Tool, human input, existing query Tools, and consume/dispose Draft Tool. It removes candidate output/terminal policy, adds `inventory_intake`, routes all receipt/manual/photo/gift/purchase intake here, and defines missing Ingredient/Food handoffs that resume this Skill.

Instructions specify source/date rules, structured blockers, one-at-a-time questions in original order, extra-purchase default, profile continuation, re-read after resume, no row deletion/retry, no candidate/product-loop mechanism, and consume/dispose-only inventory operations.

- [ ] **Step 5: Rewrite shopping Skill as planning-only**

Remove intake Tools/Draft/examples/handoffs and legacy-compatibility wording. Retain reads, create/update/delete, restore `done=false`, low-stock and shortage planning, and target-profile handoffs used to create shopping items. Route “买到了”“按小票入库”“朋友送的入库” to `inventory_analysis`.

The target `shopping-list/skill.yaml` must not contain any of these strings:

```text
shopping.preview_intake_candidates
shopping.create_intake_draft
shopping_intake
shopping_completed_ingredient
shopping_completed_food
shopping_to_stock.v1
```

Its examples that include completion/intake move to the inventory manifest. `shopping.create_draft` continues rejecting new `set_done(done=true)` with a message that the request belongs to `inventory_analysis`; it must not refer to a removed shopping Tool.

- [ ] **Step 6: Replace eval cases**

Add IDs:

```text
inventory.manual_direct_intake
inventory.purchase_source_disambiguation
inventory.gift_ignores_pending_shopping
inventory.receipt_mixed_requires_unit_input
inventory.receipt_mixed_creates_one_draft
inventory.partial_purchase_keeps_remainder
inventory.date_conflict_requests_input
```

Mixed first pass expects resolver→human input. Resumed pass expects resolver→new Draft and checks egg/salmon shopping links, milk direct row, garbage-bag ignored row. Fixtures may not inject hidden unit knowledge.

Each eval declares the Tool order, terminal result category, and critical Draft fields. The resumed mixed case checks:

```json
{
  "items.0.sourceKind": "shopping_item",
  "items.0.action": "stock_and_fulfill",
  "items.1.sourceKind": "shopping_item",
  "items.2.sourceKind": "direct",
  "items.2.action": "stock_only",
  "ignoredItems.0.reasonCode": "non_inventory_item"
}
```

The fixture resolver result includes salmon’s real supported unit so the provider cannot succeed using fixture knowledge unavailable to the model.

- [ ] **Step 7: Verify and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_skill_contract_v3.py tests/ai_infra/test_skill_contract_repairs.py tests/ai_infra/test_ai_inventory_intake.py tests/ai_evals/test_eval_dataset.py -q
git add backend/app/ai/skills/state_schemas.py backend/app/ai/skills/catalog/inventory-analysis backend/app/ai/skills/catalog/shopping-list backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_skill_contract_repairs.py backend/tests/ai_infra/test_ai_inventory_intake.py backend/tests/ai_evals/cases/core.jsonl backend/tests/ai_evals/test_eval_dataset.py
git commit -m "Move all inventory intake into inventory skill"
```

---

### Task 6: Remove Legacy AI Restock and Intake Paths

**Files:**

- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/ai/tools/catalog/inventory.py`
- Modify: `backend/app/ai/tools/draft_validation.py`
- Modify: `backend/app/services/ai_operations/inventory.py`
- Modify: `backend/app/services/ai_operations/draft_specs/inventory.py`
- Modify: `backend/app/services/ai_operations/experience.py`
- Modify: `backend/app/services/ai_operations/composite.py`
- Modify: `backend/app/services/ai_operations/registry_types.py`
- Modify: `backend/tests/ai_infra/test_inventory_operations.py`
- Modify: `backend/tests/ai_infra/test_composite_operations.py`
- Modify: `backend/tests/ai_infra/test_product_closed_loops.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Modify: `backend/tests/ai_infra/_support.py`

**Interfaces:** Produces `inventory_operation.v1` with only `consume|dispose`; inventory-summary quick restock creates `inventory_intake.v1`.

**Per-file cutover:**

| File | Required change |
|---|---|
| `ai/tools/schemas.py` | inventory-operation action enum becomes consume/dispose; delete one-time restock schema fields that are unused by those actions |
| `ai/tools/catalog/inventory.py` | delete `inventory.create_unit_conversion_operation_draft`; keep query and consume/dispose Draft Tool registration |
| `ai/tools/draft_validation.py` | reject restock before loading batches; delete restock normalization branch |
| `services/ai_operations/inventory.py` | normalizer/executor handle consume/dispose only |
| `draft_specs/inventory.py` | preview labels/counts contain no restock |
| `services/ai_operations/experience.py` | card restock constructs new Draft; consume/dispose keep old Draft |
| `services/ai_operations/composite.py` | remove inventory restock step label and validation route |
| `registry_types.py` | remove restock from AI approval result label mapping if no remaining AI consumer |
| frontend inventory-operation model/editor | completed in Task 8; no restock option or rendering |

Keep `restock` in non-AI product API enums/types where the food/inventory pages still use their own product operations. The forbidden search in Task 9 is intentionally scoped to AI contracts, not the entire repository.

- [ ] **Step 1: Add failing absence and quick-restock tests**

Reuse the existing inventory-card test setup in `test_product_closed_loops.py`. Expose the created message, validated part/card/item IDs, current family/user, and the test’s existing `create_draft_approval` callback through the local fixture object used below; do not create a second fake approval implementation.

```python
def test_inventory_operation_rejects_restock_action(db_context) -> None:
    with pytest.raises(ValueError, match="入库请使用 inventory_intake"):
        normalize_ai_draft_payload(
            db_context.db,
            draft_type="inventory_operation",
            family_id=db_context.family.id,
            user_id=db_context.user.id,
            conversation_id="conversation",
            payload={"draftType": "inventory_operation", "schemaVersion": "inventory_operation.v1", "operations": [{"action": "restock", "ingredientId": db_context.ingredient.id}]},
        )

def test_inventory_card_restock_creates_inventory_intake_draft(context) -> None:
    message = create_inventory_quick_draft_from_card(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        message_id=context.message.id,
        part_id=context.part_id,
        card_id=context.card_id,
        item_id=context.item_id,
        action="restock",
        create_draft_approval=context.create_draft_approval,
    )
    draft_part = next(part for part in message.parts if part["type"] == "draft")
    assert draft_part["draft"]["draft_type"] == "inventory_intake"
    assert draft_part["draft"]["payload"]["items"][0]["action"] == "stock_only"
```

- [ ] **Step 2: Verify red**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_inventory_operations.py tests/ai_infra/test_product_closed_loops.py -q
```

Expected: FAIL because restock still routes to inventory operation.

- [ ] **Step 3: Remove model-visible restock**

Change action sets from `restock|consume|dispose` to `consume|dispose`; old restock input raises `入库请使用 inventory_intake 草稿`. Delete restock purchase/date/storage/presence creation, labels, result metadata, and composite-step support from AI modules. Keep domain/product stock services.

Delete `inventory.create_unit_conversion_operation_draft` and its handler/schema registration. A confirmed one-time conversion now sets `packageConversion` on the formal intake row; saved long-term conversions still use Ingredient profile continuation.

- [ ] **Step 4: Reroute quick restock**

For a real inventory-summary Ingredient, build a formal `inventory_intake.v1` payload with `sourceType=manual_text`, family date, `sourceKind=direct`, `action=stock_only`, target kind derived from tracking mode, quantity 1 only for exact tracking, Ingredient defaults, and card source reference. Let the new normalizer stamp versions.

Exact quick-Draft fields are:

```python
is_exact = tracks_quantity(ingredient)
payload = {
    "draftType": "inventory_intake",
    "schemaVersion": "inventory_intake.v1",
    "sourceType": "manual_text",
    "sourceReference": {
        "messageId": message.id,
        "partId": part_id,
        "cardId": effective_card_id,
        "itemId": item_id,
    },
    "intakeDate": today_for_family(family_id).isoformat(),
    "intakeDateSource": "family_business_date",
    "items": [{
        "lineId": f"card:{item_id}",
        "sourceLineId": item_id,
        "sourceText": ingredient.name,
        "sourceKind": "direct",
        "action": "stock_only",
        "targetKind": "exact_ingredient" if is_exact else "presence_ingredient",
        "targetId": ingredient.id,
        "enteredQuantity": "1" if is_exact else None,
        "enteredUnit": ingredient.default_unit if is_exact else None,
        "inventoryStatus": "fresh",
        "storageLocation": ingredient.default_storage,
        "notes": "",
    }],
    "ignoredItems": [],
}
```

Tests assert the actual fixture IDs, names, and family date emitted by the function.

- [ ] **Step 5: Delete legacy fixtures**

Remove scripted preview Tools, old Draft Tool/type, `shopping_to_stock.v1`, and candidate output. Update supported Draft sets/labels. Remove composite create-Ingredient→restock tests; profile continuation→inventory intake is the replacement.

After cleanup, add explicit absence assertions rather than merely deleting positive tests:

```python
from typing import get_args

assert "restock" not in INVENTORY_OPERATION_DRAFT_SCHEMA["properties"]["operations"]["items"]["properties"]["action"]["enum"]
tool_names = {definition.name for definition in build_workspace_tool_registry().list()}
assert "inventory.preview_intake_candidates" not in tool_names
assert "shopping.preview_intake_candidates" not in tool_names
assert "shopping.create_intake_draft" not in tool_names
assert "inventory.create_unit_conversion_operation_draft" not in tool_names
assert "inventory_intake_candidates" not in get_args(AIResultCardType)
assert "shopping_to_stock.v1" not in CONTINUATION_STATE_ADAPTERS
assert "ready_food_stock.v1" not in CONTINUATION_STATE_ADAPTERS
```

- [ ] **Step 6: Verify and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_inventory_operations.py tests/ai_infra/test_composite_operations.py tests/ai_infra/test_product_closed_loops.py tests/ai_infra/test_workspace_approvals.py tests/ai_infra/test_registry_and_metrics.py -q
git add backend/app/ai/tools/schemas.py backend/app/ai/tools/catalog/inventory.py backend/app/ai/tools/draft_validation.py backend/app/services/ai_operations/inventory.py backend/app/services/ai_operations/draft_specs/inventory.py backend/app/services/ai_operations/experience.py backend/app/services/ai_operations/composite.py backend/app/services/ai_operations/registry_types.py backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_composite_operations.py backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_registry_and_metrics.py backend/tests/ai_infra/_support.py
git commit -m "Remove legacy AI restock and intake paths"
```

### Task 7: Build the Formal Approval Model and Editor

**Files:**

- Create: `frontend/src/components/ai/aiInventoryIntakeDraftModel.ts` and test.
- Create: `frontend/src/components/ai/AiInventoryIntakeApproval.tsx`.
- Delete: `frontend/src/components/ai/AiShoppingIntakeApproval.tsx`.
- Modify: `frontend/src/styles/09-ai-workspace.css`.

**Interfaces:** Produces parsing, grouping, action options, item patching, summaries, submit validation, and a controlled editor with `{draft, readonly, onChange}`.

**Exact model exports:**

```typescript
export type InventoryIntakeSourceKind = 'shopping_item' | 'direct';
export type InventoryIntakeAction = 'stock_and_fulfill' | 'fulfill_without_stock' | 'stock_only' | 'skip';
export type InventoryIntakeTargetKind = 'exact_ingredient' | 'presence_ingredient' | 'food' | 'none';

export type InventoryIntakeDraft = {
  draftType: 'inventory_intake';
  schemaVersion: 'inventory_intake.v1';
  clientRequestId: string;
  sourceType: string;
  sourceReference: Record<string, unknown> | null;
  intakeDate: string;
  intakeDateSource: 'user' | 'receipt' | 'family_business_date';
  items: InventoryIntakeDraftItem[];
  ignoredItems: InventoryIntakeIgnoredItem[];
  summary: Record<string, unknown>;
  [key: string]: unknown;
};

export function inventoryIntakeDraftFromRecord(value: Record<string, unknown>): InventoryIntakeDraft;
export function groupInventoryIntakeItems(draft: InventoryIntakeDraft): {
  shopping: InventoryIntakeDraftItem[];
  direct: InventoryIntakeDraftItem[];
  ignored: InventoryIntakeIgnoredItem[];
};
export function inventoryIntakeActionOptions(sourceKind: InventoryIntakeSourceKind): Array<{ value: InventoryIntakeAction; label: string }>;
export function patchInventoryIntakeItem(draft: InventoryIntakeDraft, lineId: string, patch: Partial<InventoryIntakeDraftItem>): InventoryIntakeDraft;
export function inventoryIntakeItemSummary(item: InventoryIntakeDraftItem): string;
export function validateInventoryIntakeDraftForSubmit(draft: Record<string, unknown>): string;
```

`inventoryIntakeDraftFromRecord()` is defensive at the API boundary but never fabricates a missing identity/version. If required identity fields are malformed, the model retains an invalid empty value so submit validation blocks and shows a concrete error; it does not silently switch target/source.

**Submit validation order:**

1. valid top-level date and at least one item;
2. at least one action other than skip;
3. source/action combination;
4. required protected identity present;
5. exact/Food positive entered quantity and non-empty unit;
6. package conversion ratio > 0 plus target unit/evidence;
7. presence availability is present_unknown/low/sufficient;
8. stock action has storage location;
9. expiry is a real date and not earlier than intake date.

Return the first concrete Chinese message naming the row, for example `请填写「牛奶」的实际入库数量`.

- [ ] **Step 1: Write failing pure-model tests**

```typescript
it('groups shopping, direct, and ignored rows', () => {
  const draft = inventoryIntakeDraftFromRecord({
    draftType: 'inventory_intake',
    schemaVersion: 'inventory_intake.v1',
    intakeDate: '2026-07-21',
    intakeDateSource: 'receipt',
    items: [
      { lineId: 'egg', sourceKind: 'shopping_item', action: 'stock_and_fulfill', title: '鸡蛋' },
      { lineId: 'milk', sourceKind: 'direct', action: 'stock_only', title: '牛奶' },
    ],
    ignoredItems: [{ sourceLineId: 'bags', displayName: '垃圾袋', reason: '非食品库存对象' }],
  });
  const groups = groupInventoryIntakeItems(draft);
  expect(groups.shopping.map((item) => item.lineId)).toEqual(['egg']);
  expect(groups.direct.map((item) => item.lineId)).toEqual(['milk']);
  expect(groups.ignored.map((item) => item.sourceLineId)).toEqual(['bags']);
});

it('exposes only source-compatible actions', () => {
  expect(inventoryIntakeActionOptions('shopping_item').map((item) => item.value))
    .toEqual(['stock_and_fulfill', 'fulfill_without_stock', 'skip']);
  expect(inventoryIntakeActionOptions('direct').map((item) => item.value))
    .toEqual(['stock_only', 'skip']);
});
```

Add tests for protected-field preservation, package conversion, partial purchase summary, exact/Food positive quantity/unit, presence no-quantity behavior, storage, date, and all-skip rejection.

Use exact test names:

```text
groups shopping direct and ignored rows in source order
exposes only source-compatible actions
patches editable fields without dropping protected server fields
summarizes partial shopping purchase and remaining quantity
summarizes direct row without claiming shopping completion
validates exact and food quantity and unit
validates package conversion evidence
allows presence intake without numeric quantity
validates storage and date range
rejects all skipped rows
```

- [ ] **Step 2: Verify red**

```bash
npm --prefix frontend run test -- src/components/ai/aiInventoryIntakeDraftModel.test.ts
```

Expected: missing module failure.

- [ ] **Step 3: Implement explicit types and pure model**

Define `InventoryIntakeSourceKind`, `InventoryIntakeAction`, `InventoryIntakeTargetKind`, typed Draft items/ignored rows, and functions `inventoryIntakeDraftFromRecord`, `groupInventoryIntakeItems`, `inventoryIntakeActionOptions`, `patchInventoryIntakeItem`, and `validateInventoryIntakeDraftForSubmit`. Patching spreads the original server row before editable changes so protected fields remain intact.

- [ ] **Step 4: Implement grouped controlled editor**

Render compact intake date/source/count header; groups 采购清单关联、直接入库、已忽略 with counts; row disclosures with real buttons and `aria-expanded`; source-compatible action select; quantity/unit, presence status, conversion, storage, expiry, status, notes; and a summary footer. Direct rows state “只增加库存，不创建或完成采购项”. Ignored rows are read-only. Render no submit button.

Use this component hierarchy so the implementer does not need to redesign the form:

```text
section.ai-inventory-intake-editor[aria-label="确认入库内容"]
  header.ai-inventory-intake-overview
    intake date + source badge
    stock/shopping counts
  section.ai-inventory-intake-group (shopping)
    group header
    article.ai-inventory-intake-row × N
      disclosure button
      expanded field body
  section.ai-inventory-intake-group (direct)
    group header + direct explanation
    rows
  aside.ai-inventory-intake-ignored
    read-only ignored rows/reasons
  footer.ai-inventory-intake-submit-summary
    one sentence impact summary
```

Rows needing missing editable information start expanded; complete rows start collapsed. Expansion is the component’s only local state. All business values remain controlled by `draft/onChange`. Changing action to skip retains other values in the Draft so switching back does not erase user input.

- [ ] **Step 5: Replace styles with canonical editor styles**

Delete old candidate and shopping-intake AI classes. Add `.ai-inventory-intake-editor*` using canonical surfaces, borders, radius, text/space/control tokens, no nested card shadow, 44px targets, 48px touch inputs, `min-width:0`, safe wrapping, and one column under 768px. Status groups use text plus semantic color.

Desktop/tablet may use two columns only inside the expanded advanced-field grid. Group and row structure stays one vertical flow at every viewport so the approval container remains the single scroll owner. Do not add sticky actions inside this editor.

- [ ] **Step 6: Verify and commit**

```bash
npm --prefix frontend run test -- src/components/ai/aiInventoryIntakeDraftModel.test.ts
npm run frontend:typecheck
git add frontend/src/components/ai/aiInventoryIntakeDraftModel.ts frontend/src/components/ai/aiInventoryIntakeDraftModel.test.ts frontend/src/components/ai/AiInventoryIntakeApproval.tsx frontend/src/styles/09-ai-workspace.css
git rm frontend/src/components/ai/AiShoppingIntakeApproval.tsx
git commit -m "Build formal inventory intake approval editor"
```

---

### Task 8: Integrate the Draft and Delete Candidate UI

**Files:**

- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/lib/aiWorkspaceContracts.ts`
- Modify: `frontend/src/lib/aiWorkspaceContracts.test.ts`
- Modify: `frontend/src/components/ai/AiApprovalPanel.tsx`
- Modify: `frontend/src/components/ai/AiApprovalPanel.test.tsx`
- Modify: `frontend/src/components/ai/AiResultCards.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.tsx`
- Modify: `frontend/src/components/ai/AiMobilePage.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Modify: `frontend/src/components/ai/AiProductLoopCards.test.tsx`
- Modify: `frontend/src/components/ai/aiInventoryOperationDraftModel.ts`
- Modify: `frontend/src/components/ai/AiInventoryOperationEditor.tsx`
- Modify: `frontend/src/styles/09-ai-workspace.css`
- Delete: `frontend/src/components/ai/AiInventoryIntakeCandidates.tsx`

**Interfaces:** Consumes Task 7 editor/model and existing generic approval decisions; produces no intake result-card renderer or inventory-specific product loop.

**Exact frontend contract changes:**

| Location | Before | After |
|---|---|---|
| `AiTaskDraftType` | includes `shopping_intake` | includes `inventory_intake` only |
| `AiApprovalField.widget` | includes `shopping_intake_editor` | includes `inventory_intake_editor` only |
| `AiResultCardType` | includes `inventory_intake_candidates` | candidate type removed |
| candidate interface | `AiInventoryIntakeCandidate` | deleted |
| approval specialized import | `AiShoppingIntakeApproval` | `AiInventoryIntakeApproval` |
| submit validator | shopping intake validator | Task 7 intake validator |
| inventory-operation action | restock/consume/dispose | consume/dispose |

`AiProductLoopPrompt` remains because `AiMealIdeaProposal` still uses it. Do not propagate removal beyond the inventory-specific branch.

**Known dispatch points to edit:**

- `AiApprovalPanel.tsx`: validation branch near the existing `draftType === 'shopping_intake'` check and specialized editor branch near `renderStructuredDraftEditor()`.
- `AiResultCards.tsx`: remove the `inventory_intake_candidates` renderer and component import.
- `AiConversationThread.tsx` and `AiMobilePage.tsx`: remove a product-loop prop only if it becomes unused after checking other rendered cards.
- `AiWorkspace.tsx`: remove only the callback path that submits `source: inventory_intake_candidates`; keep generic composer and meal-idea paths.
- `aiWorkspaceContracts.ts`: remove candidate result type/renderer entry; `draft` and `approval_request` support remain unchanged.
- `09-ai-workspace.css`: after Task 7, `rg 'ai-shopping-intake|ai-inventory-intake-card'` must return no old class.

- [ ] **Step 1: Write failing integration tests**

Use `approval_type=inventory_intake.apply`, `draft_schema_version=inventory_intake.v1`, widget `inventory_intake_editor`, and a fixture containing shopping egg/salmon, direct milk, and ignored garbage bag. Assert three group headings, direct-row explanation, ignored explanation, one outer approval button, compatible action options, validation message, and preserved protected fields.

Add/rename these exact ApprovalPanel tests:

```text
renders inventory intake grouped by business impact
edits shopping and direct rows through the existing approval payload
does not render editable controls for ignored rows
offers source-compatible actions only
blocks missing quantity unit storage conversion and invalid date
submits one draft while preserving protected fields
renders approved inventory intake read only
```

Update product-loop tests to retain meal-idea coverage and assert no candidate-card button with text `按选中项准备入库` exists.

Update workspace-contract test to assert `inventory_intake_candidates` is absent.

- [ ] **Step 2: Verify red**

```bash
npm --prefix frontend run test -- src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiProductLoopCards.test.tsx src/components/ai/AiWorkspace.test.tsx
```

Expected: FAIL while old types/dispatch remain.

- [ ] **Step 3: Cut over types and approval dispatch**

Replace AI Draft/widget names with `inventory_intake`/`inventory_intake_editor`; remove candidate result-card and candidate item types. Keep `AiProductLoopPrompt` for meal-idea/recipe flows. Dispatch `draftType === 'inventory_intake'` to Task 7 editor and validator through existing `AiApprovalPanel`.

The approval panel continues to pass `currentApproval.initial_values.draft` through its existing structured Draft state and submit the existing decision request. Do not add an intake API client, React Query mutation, cache invalidation, or approval hook; those would duplicate the existing AI approval infrastructure.

- [ ] **Step 4: Remove only inventory candidate product loop**

Delete candidate branch/prop use from result cards and workspace, delete the component, and remove the inventory-candidate subject-source composer path. Retain meal-idea product-loop behavior and tests.

- [ ] **Step 5: Remove restock from inventory-operation editor**

Frontend inventory-operation action union becomes `consume|dispose`. Remove restock counts, fields, presence-restock logic, and validation. Formal restock UI now belongs only to the intake editor.

Update both pure model and visible editor tests so they assert exactly two categories, consume and dispose. Do not retain hidden restock parsing for compatibility: the removed AI Draft was not released.

- [ ] **Step 6: Verify quality and commit**

```bash
npm --prefix frontend run test -- src/components/ai/aiInventoryIntakeDraftModel.test.ts src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiProductLoopCards.test.tsx src/components/ai/AiWorkspace.test.tsx src/lib/aiWorkspaceContracts.test.ts
npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens
git add frontend/src/api/types.ts frontend/src/lib/aiWorkspaceContracts.ts frontend/src/lib/aiWorkspaceContracts.test.ts frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/components/ai/AiResultCards.tsx frontend/src/components/ai/AiConversationThread.tsx frontend/src/components/ai/AiMobilePage.tsx frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspace.test.tsx frontend/src/components/ai/AiProductLoopCards.test.tsx frontend/src/components/ai/aiInventoryOperationDraftModel.ts frontend/src/components/ai/AiInventoryOperationEditor.tsx frontend/src/styles/09-ai-workspace.css
git rm frontend/src/components/ai/AiInventoryIntakeCandidates.tsx
git commit -m "Integrate unified inventory intake draft"
```

Expected: focused tests, typecheck, full Vitest, build, and bundle budgets pass. Manually review style-token report entries.

---

### Task 9: Cross-Stack Acceptance and Release Gate

**Files:** Modify only tests/contracts directly broken by Tasks 1–8; add no new behavior.

**Interfaces:** Produces release evidence and a clean model-visible contract.

- [ ] **Step 1: Search for forbidden old AI contracts**

```bash
rg -n "shopping_intake|shopping\.create_intake_draft|shopping\.preview_intake_candidates|inventory\.preview_intake_candidates|inventory\.create_unit_conversion_operation_draft|inventory_intake_candidates|AiInventoryIntakeCandidates|shopping_intake_editor" backend/app/ai backend/app/services/ai_operations backend/tests/ai_infra backend/tests/ai_evals frontend/src/components/ai frontend/src/lib/aiWorkspaceContracts.ts frontend/src/api/types.ts
```

Expected: no output. Product-only `shopping_intake` is allowed only in public shopping API/schema/tests, persisted history enums, and non-AI shopping intake frontend/API files.

- [ ] **Step 2: Run focused backend suites**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_intake_service.py tests/shopping/test_shopping_intake_api.py tests/ai_infra/test_ai_inventory_intake.py tests/ai_infra/test_inventory_operations.py tests/ai_infra/test_product_closed_loops.py tests/ai_infra/test_skill_contract_v3.py tests/ai_infra/test_skill_contract_repairs.py tests/ai_infra/test_workspace_approvals.py tests/ai_infra/test_registry_and_metrics.py tests/ai_evals/test_eval_dataset.py -q
```

Expected: PASS.

- [ ] **Step 3: Run full AI and eval gates**

```bash
npm run backend:test:ai
npm run backend:test:ai-evals
npm run backend:check:ai-evals
```

Expected: all AI infra/evals pass and threshold report is accepted.

- [ ] **Step 4: Run service and concurrency gates**

```bash
npm run db:up
npm run backend:test:service
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py -q
```

Expected: PASS with no deadlock, duplicate intake, or partial transaction.

- [ ] **Step 5: Run frontend gates**

```bash
npm run frontend:quality
npm run frontend:build
npm run frontend:smoke
npm --prefix frontend run check:style-tokens
```

Expected: quality/build/smoke pass; manually classify style report entries.

- [ ] **Step 6: Smoke the reported receipt**

Prepare pending shopping items chicken egg and salmon, with no milk item. Submit milk 1 bag, chicken egg 2, salmon 0.268 kg, and garbage bag 1. Verify: egg shopping-ready; salmon remains a unit blocker; milk direct stock-only; garbage bag ignored; after salmon answer one Draft contains all business rows; groups are 2/1/1; one approval updates shopping and inventory; forced stale leaves both unchanged.

- [ ] **Step 7: Inspect fixed viewports**

Inspect authenticated AI approval at 375×812, 390×844, 430×932, 768×1024, 1024×768, and 1440×900. Verify long text, expanded conversion, validation errors, read-only resolved state, focus order, control sizes, composer/safe-area overlap, no horizontal overflow, and one primary action.

- [ ] **Step 8: Final checks**

```bash
npm run backend:typecheck
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: compile/diff checks pass and worktree is clean after final commit.

- [ ] **Step 9: Commit only gate-related corrections**

If no correction was needed, create no empty commit. Otherwise stage explicit related paths and use:

```bash
git commit -m "Complete unified intake acceptance coverage"
```

## Specification Coverage Map

| Approved specification requirement | Implementation task | Primary verification |
|---|---|---|
| Skill boundary: shopping planning vs actual inventory facts | Task 5 | Skill contract and routing evals |
| One resolver for receipt/manual/photo/gift/reconciliation | Task 4 | resolver named test matrix |
| Expected business problems are structured output | Task 4 | reason-code tests and Tool status assertions |
| Blockers handled one at a time without losing rows | Task 5 | human-input resume test and mixed eval |
| Missing Ingredient/Food profile continuation | Task 5 | typed state and approval resume tests |
| Date precedence and explicit conflict | Tasks 4–5 | resolver date tests and eval |
| Extra purchase defaults to direct stock only | Tasks 4–5 | resolver and manual-direct eval |
| Formal `inventory_intake.v1` only | Task 3 | registry, normalizer, approval tests |
| Shopping-linked/direct/ignored in one Draft | Tasks 3 and 7 | backend normalization and frontend grouping tests |
| Editable vs immutable approval fields | Tasks 3 and 7 | backend tamper tests and frontend preservation tests |
| One atomic mixed transaction | Task 2 | mixed service, rollback, stale, replay, MySQL tests |
| Partial purchase and remaining quantity | Tasks 2 and 7 | service test and summary model test |
| Existing product shopping endpoint preserved | Tasks 1–2 | public API regression suite |
| All AI restock uses intake; consume/dispose remain | Tasks 6 and 8 | backend/frontend absence and quick-action tests |
| Candidate card and second-run path deleted | Tasks 4, 6, and 8 | registry/contract/product-loop absence tests |
| Existing Draft infrastructure reused | Tasks 3, 7, and 8 | standard Draft registry and ApprovalPanel tests |
| Grouped, compact, mobile-first approval UI | Tasks 7–9 | component tests, style report, smoke, six viewports |
| No AI infrastructure or inventory-adjust scope expansion | Global Constraints and Task 9 | changed-path audit against this plan |

An executor should not mark Task 9 complete unless every row above has corresponding fresh evidence. If an implementation discovery requires changing a product decision in this table, stop and return to the specification rather than silently altering the plan.

## Completion Evidence Checklist

- [ ] New Draft names match across backend schema, registry, Skill, frontend widget/type, tests, and evals.
- [ ] No old model-visible intake name, candidate card, local selection, or inventory-specific product loop remains.
- [ ] Product shopping intake HTTP behavior remains green through generalized adapter.
- [ ] Direct exact Ingredient, presence Ingredient, Food, and mixed shopping/direct intake are covered.
- [ ] Partial purchase, stale, cross-family, replay, request-hash conflict, and rollback are covered.
- [ ] Expected ambiguity is resolver data, not Tool failure.
- [ ] Typed continuation resumes evidence without stale row versions.
- [ ] Inventory operation accepts only consume/dispose.
- [ ] Frontend groups business impact and uses generic Draft/approval capability.
- [ ] Focused/full backend/frontend tests, evals, build, smoke, style report, MySQL concurrency, and manual viewports are reported.
