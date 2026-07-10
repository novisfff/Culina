# AI Skill Phase 3 Product Closed Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repaired v3 Skill runtime into user-visible household workflows that carry real entity identities across Skills while preserving one approval boundary per business write.

**Architecture:** Reuse the Phase 2 typed handoff and continuation layer instead of adding a general workflow engine. Add a compact family preference context, then implement five product loops: completed shopping to stock intake, cooking shortage to shopping, AI meal logging to optional ready-food deduction, attachment-backed recipe and meal drafts, and inventory-backed recommendation proposals. Every cross-domain transition creates a new proposal or draft and pauses for explicit user confirmation.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic, LangGraph, React 18, TypeScript, React Query, pytest, Vitest.

## Global Constraints

- Phase 1 and Phase 2 must be merged and their verification gates green before this phase starts.
- Every ingredient, Food, Recipe, meal-plan, shopping-item, media, and member reference must resolve inside the active family.
- Search is candidate recall only. The selected entity must be re-read and family-scoped before it enters a draft.
- A shopping completion approval and a stock intake approval are two distinct business writes. Never silently combine them.
- A recipe shortage may create a shopping proposal, but it must not claim that the kitchen is ready until purchase and stock intake actually occur.
- Meal-log stock deduction applies only to ready-like Food and only after the meal-log draft is approved.
- Current-message media may be attached only when its real media ID is present in currentAttachments and ownership validation succeeds.
- Family food preferences and avoidances are household context, not medical advice or nutritional diagnosis.
- Keep the existing one-active-draft-per-run rule. Multi-domain flows continue after approval through a typed continuation artifact.
- All user-visible copy remains Simplified Chinese and the existing mobile-first visual language remains unchanged.
- All final verification commands actually run during implementation must be reported.

---

## File Structure

Create:

- backend/alembic/versions/0c1d2e3f4a5b_add_family_food_preferences.py: add household preference JSON columns.
- backend/app/ai/tools/catalog/family_context.py: family preference and member context read Tool.
- backend/app/ai/workflows/orchestrator/product_continuations.py: typed continuation builders for product loops.
- backend/app/ai/tools/catalog/inventory_intake.py: image-assisted inventory candidate preview Tool.
- backend/app/ai/tools/catalog/meal_ideas.py: inventory-backed meal idea proposal Tool.
- backend/tests/ai_infra/test_product_closed_loops.py: cross-Skill continuation and approval integration tests.
- backend/tests/ai_infra/test_family_context_tool.py: family isolation and safe member projection tests.
- frontend/src/components/ai/AiInventoryIntakeCandidates.tsx: selectable candidate card.
- frontend/src/components/ai/AiMealIdeaProposal.tsx: empty-library recommendation card.
- frontend/src/components/ai/AiProductLoopCards.test.tsx: card behavior and prompt action tests.

Modify:

- backend/app/models/domain.py: household preference fields.
- backend/app/schemas/family.py: preference request and response contract.
- backend/app/api/family.py: owner-scoped preference update.
- backend/app/ai/tools/catalog/__init__.py and backend/app/ai/tools/registry.py: register new read/proposal Tools.
- backend/app/ai/skills/state_schemas.py: product continuation schemas.
- backend/app/ai/skills/catalog/shopping-list/skill.yaml and SKILL.md: stock-intake handoff.
- backend/app/ai/skills/catalog/recipe-cook/skill.yaml and SKILL.md: shortage-to-shopping handoff.
- backend/app/ai/skills/catalog/meal-record/skill.yaml and SKILL.md: optional stock deduction and attachment policy.
- backend/app/ai/skills/catalog/recipe-draft/skill.yaml and SKILL.md: current-message attachment binding.
- backend/app/ai/skills/catalog/meal-planning/skill.yaml and SKILL.md: family context and empty-library proposal.
- backend/app/ai/skills/catalog/inventory-analysis/skill.yaml and SKILL.md: intake candidate preview.
- backend/app/services/ai_operations/meal_logs.py: transactional ready-food deduction.
- backend/app/services/ai_operations/draft_specs/planning.py: expanded meal-log draft normalization and preview.
- backend/app/ai/tools/schemas.py: meal-log stock fields.
- backend/app/ai/workflows/runner_support/attachments.py: shared current-message media ownership validation.
- backend/app/schemas/ai.py: result-card DTOs for product-loop proposals.
- frontend/src/api/types.ts: family preferences, draft fields, and output-card types.
- frontend/src/api/familyApi.ts: preference update payload.
- frontend/src/features/family/FamilySettings.tsx and FamilySettingsModals.tsx: owner editing UI.
- frontend/src/features/family/useFamilySettingsState.ts: preference form state.
- frontend/src/components/ai/AiResultCards.tsx: render new card types.
- frontend/src/components/ai/AiConversationThread.tsx: pass product-loop card actions through the conversation renderer.
- frontend/src/components/ai/AiMobilePage.tsx: pass product-loop card actions through the mobile renderer.
- frontend/src/components/ai/AiWorkspace.tsx: submit card actions as ordinary AI turns with quick_task and subject.
- frontend/src/lib/aiWorkspaceContracts.ts: keep backend and frontend card literals aligned.
- frontend/src/components/ai/AiApprovalFields.tsx: meal-log stock deduction controls.
- docs/ai-assistant-standards.md: cross-Skill product-loop rules.

---

### Task 1: Add Family Preference Context Without Exposing Sensitive Member Data

**Files:**
- Create: backend/alembic/versions/0c1d2e3f4a5b_add_family_food_preferences.py
- Create: backend/app/ai/tools/catalog/family_context.py
- Create: backend/tests/ai_infra/test_family_context_tool.py
- Modify: backend/app/models/domain.py
- Modify: backend/app/schemas/family.py
- Modify: backend/app/api/family.py
- Modify: backend/app/ai/tools/catalog/__init__.py
- Modify: backend/app/ai/tools/registry.py
- Modify: frontend/src/api/types.ts
- Modify: frontend/src/api/familyApi.ts
- Modify: frontend/src/features/family/FamilySettings.tsx
- Modify: frontend/src/features/family/FamilySettingsModals.tsx
- Modify: frontend/src/features/family/useFamilySettingsState.ts
- Test: backend/tests/family/test_family_api.py
- Create: frontend/src/features/family/FamilySettings.test.tsx

**Interfaces:**
- Produces: Family.food_preferences and Family.food_avoidances as JSON arrays of trimmed unique strings.
- Produces: family.read_context with familyId, name, location, preferences, avoidances, and safe active-member projections.
- Consumed by: meal_plan, meal_log, recipe_cook, and recipe_draft Skills.

- [ ] **Step 1: Write failing family API and Tool isolation tests**

Add these cases before changing the model:

    def test_owner_can_update_food_context(self) -> None:
        response = self.client.patch(
            "/api/family",
            json={
                "name": self.family.name,
                "motto": self.family.motto,
                "location": self.family.location,
                "food_preferences": ["少油", " 清淡 ", "少油"],
                "food_avoidances": ["花生"],
            },
        )
        assert response.status_code == 200
        assert response.json()["food_preferences"] == ["少油", "清淡"]
        assert response.json()["food_avoidances"] == ["花生"]

    def test_non_owner_cannot_update_food_context(self) -> None:
        self.login_as_member()
        response = self.client.patch(
            "/api/family",
            json={
                "name": self.family.name,
                "motto": self.family.motto,
                "location": self.family.location,
                "food_preferences": ["清淡"],
            },
        )
        assert response.status_code == 403

    def test_family_context_returns_only_current_family_members(tool_context) -> None:
        result = execute_family_read_context(tool_context, {})
        assert result["familyId"] == tool_context.family_id
        assert all(item["familyId"] == tool_context.family_id for item in result["members"])
        assert all("email" not in item and "phone" not in item for item in result["members"])

- [ ] **Step 2: Run the focused tests and confirm the missing-field failures**

Run:

    backend/.venv/bin/pytest backend/tests/family/test_family_api.py backend/tests/ai_infra/test_family_context_tool.py -q

Expected: preference payload assertions fail because the Family schema and Tool do not exist.

- [ ] **Step 3: Add the migration and normalized schema**

The migration must use down_revision = "fb0c1d2e3f4a" and add two non-null JSON columns with an empty JSON array server default. Remove the server defaults after backfill so future writes always pass through application defaults.

Add model fields:

    food_preferences: Mapped[list[str]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )
    food_avoidances: Mapped[list[str]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )

Add a shared Pydantic validator:

    @field_validator("food_preferences", "food_avoidances")
    @classmethod
    def normalize_food_context(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for raw in value:
            item = raw.strip()
            if item and item not in normalized:
                normalized.append(item)
        if len(normalized) > 20:
            raise ValueError("每类最多填写 20 项")
        if any(len(item) > 40 for item in normalized):
            raise ValueError("单项不能超过 40 个字符")
        return normalized

- [ ] **Step 4: Implement owner update and the safe family Tool projection**

The Tool handler must derive family_id from ToolExecutionContext, never from arguments:

    def execute_family_read_context(
        context: ToolExecutionContext,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        family = context.db.get(Family, context.family_id)
        if family is None:
            raise ToolExecutionError("family_not_found", "当前家庭不存在")

        members = list(
            context.db.scalars(
                select(Membership)
                .where(
                    Membership.family_id == context.family_id,
                    Membership.status == MembershipStatus.ACTIVE,
                )
                .order_by(Membership.created_at.asc())
            )
        )
        return {
            "familyId": family.id,
            "name": family.name,
            "location": family.location,
            "preferences": list(family.food_preferences or []),
            "avoidances": list(family.food_avoidances or []),
            "members": [
                {
                    "id": member.id,
                    "familyId": member.family_id,
                    "userId": member.user_id,
                    "displayName": member.user.display_name,
                    "role": member.role.value,
                }
                for member in members
            ],
        }

Register family.read_context as a read Tool and authorize it only in the four consuming Skills.

- [ ] **Step 5: Add the owner-facing settings form**

Use two comma/newline-tokenized inputs. Keep raw form strings in useFamilySettingsState.ts and convert them at submit time with one shared helper. On success, invalidate the existing current-family query key. Add loading, validation, 403, and empty-state tests without redesigning the settings page.

- [ ] **Step 6: Run backend, frontend, and migration verification**

Run:

    backend/.venv/bin/pytest backend/tests/family/test_family_api.py backend/tests/ai_infra/test_family_context_tool.py -q
    npm --prefix frontend run test -- FamilySettings
    cd backend && .venv/bin/alembic upgrade head && .venv/bin/alembic downgrade fb0c1d2e3f4a && .venv/bin/alembic upgrade head

Expected: all focused tests pass and the migration round-trip succeeds.

- [ ] **Step 7: Commit**

    git add backend/alembic/versions/0c1d2e3f4a5b_add_family_food_preferences.py backend/app/models/domain.py backend/app/schemas/family.py backend/app/api/family.py backend/app/ai/tools/catalog/family_context.py backend/app/ai/tools/catalog/__init__.py backend/app/ai/tools/registry.py backend/tests/family/test_family_api.py backend/tests/ai_infra/test_family_context_tool.py frontend/src/api/types.ts frontend/src/api/familyApi.ts frontend/src/features/family
    git commit -m "feat(ai): add family food preference context"

---

### Task 2: Continue Completed Shopping Items Into Explicit Stock Intake

**Files:**
- Create: backend/app/ai/workflows/orchestrator/product_continuations.py
- Create: backend/tests/ai_infra/test_product_closed_loops.py
- Modify: backend/app/ai/skills/state_schemas.py
- Modify: backend/app/ai/skills/catalog/shopping-list/skill.yaml
- Modify: backend/app/ai/skills/catalog/shopping-list/SKILL.md
- Modify: backend/app/ai/skills/catalog/shopping-list/references/workflows.md
- Modify: backend/app/ai/skills/catalog/inventory-analysis/skill.yaml
- Modify: backend/app/ai/skills/catalog/food-profile/skill.yaml
- Modify: backend/app/ai/workflows/runner_support/approval_resume_handler.py
- Test: backend/tests/ai_infra/test_workspace_streaming.py
- Test: backend/tests/ai_infra/test_workspace_approvals.py

**Interfaces:**
- Consumes: approved shopping_list set_done operation with a real ingredientId or foodId.
- Produces: shopping_to_stock.v1 continuation targeting inventory_analysis or food_profile.
- Invariant: successful shopping approval remains committed even if the follow-up draft is abandoned.

- [ ] **Step 1: Write failing ingredient and Food continuation tests**

The integration tests must prove both branches and the pause:

    def test_completed_ingredient_item_resumes_inventory_stock_draft(self) -> None:
        result = approve_completed_shopping_item(target_type="ingredient")
        continuation = result["workflowContinuation"]
        assert continuation["stateSchema"] == "shopping_to_stock.v1"
        assert continuation["resumeSkillKey"] == "inventory_analysis"
        assert continuation["state"]["ingredientId"] == self.ingredient.id
        assert continuation["state"]["shoppingItemId"] == self.shopping_item.id
        assert continuation["state"]["quantity"] == "2"
        assert continuation["state"]["unit"] == "盒"
        assert result["included"]["drafts"] == []

    def test_completed_food_item_resumes_food_stock_draft(self) -> None:
        result = approve_completed_shopping_item(target_type="food")
        continuation = result["workflowContinuation"]
        assert continuation["resumeSkillKey"] == "food_profile"
        assert continuation["state"]["foodId"] == self.food.id
        assert continuation["state"]["stockAction"] == "restock"

    def test_stock_draft_requires_second_approval(self) -> None:
        first = approve_completed_shopping_item(target_type="ingredient")
        resumed = resume_from(first["workflowContinuation"])
        assert resumed["included"]["drafts"][0]["draftType"] == "inventory_operation"
        assert inventory_quantity(self.ingredient.id) == 0

- [ ] **Step 2: Run the focused tests and confirm continuation is absent**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py -q

Expected: failures show no shopping_to_stock.v1 registry entry and no continuation emitted after approval.

- [ ] **Step 3: Register the compact continuation state model**

Add this model and adapter beside the Phase 2 state models in
state_schemas.py:

    QuantityText = Annotated[
        str,
        Field(pattern=r"^[0-9]+(?:\\.[0-9]+)?$"),
    ]


    class ShoppingToStockState(ContinuationStateModel):
        shoppingItemId: EntityId
        targetType: Literal["ingredient", "food"]
        ingredientId: EntityId | None = None
        foodId: EntityId | None = None
        quantity: QuantityText
        unit: ShortText
        stockAction: Literal["restock"]

        @model_validator(mode="after")
        def validate_target_identity(self) -> "ShoppingToStockState":
            if self.targetType == "ingredient":
                valid = self.ingredientId is not None and self.foodId is None
            else:
                valid = self.foodId is not None and self.ingredientId is None
            if not valid:
                raise ValueError(
                    "targetType must match exactly one target ID"
                )
            return self


    CONTINUATION_STATE_ADAPTERS["shopping_to_stock.v1"] = TypeAdapter(
        ShoppingToStockState
    )
    CONTINUATION_STATE_SCHEMAS["shopping_to_stock.v1"] = (
        CONTINUATION_STATE_ADAPTERS[
            "shopping_to_stock.v1"
        ].json_schema()
    )

- [ ] **Step 4: Build continuation from committed data, not model arguments**

In product_continuations.py, accept the committed operation result and re-read the shopping row:

    def build_shopping_to_stock_continuation(
        db: Session,
        *,
        family_id: str,
        shopping_item_id: str,
    ) -> dict[str, Any]:
        item = db.scalar(
            select(ShoppingListItem).where(
                ShoppingListItem.id == shopping_item_id,
                ShoppingListItem.family_id == family_id,
            )
        )
        if item is None or not item.done:
            raise ContinuationBuildError("shopping_item_not_completed")

        state = {
            "shoppingItemId": item.id,
            "targetType": "ingredient" if item.ingredient_id else "food",
            "quantity": decimal_to_string(item.quantity),
            "unit": item.unit,
            "stockAction": "restock",
        }
        if item.ingredient_id:
            state["ingredientId"] = item.ingredient_id
            resume_skill = "inventory_analysis"
            required_draft_type = "inventory_operation"
        else:
            state["foodId"] = require_value(item.food_id)
            resume_skill = "food_profile"
            required_draft_type = "food_profile"

        return {
            "workflowId": "shopping-stock:" + item.id,
            "stepKey": "stock-intake",
            "reasonCode": "shopping_completed",
            "nextSkillKey": resume_skill,
            "resumeSkillKey": resume_skill,
            "requiredDraftType": required_draft_type,
            "stateSchema": "shopping_to_stock.v1",
            "state": state,
        }

Only offer this continuation for a set_done operation. Deleting, editing, or reopening a row does not trigger it.
The approval resume handler must pass this returned payload through the Phase 2
`normalize_continuation(..., source_skill_key="shopping_list")` guard before
persisting or injecting it; product builders do not bypass v3 manifest,
profile, draft-type, or state validation.

- [ ] **Step 5: Teach both receiving Skills to create, then pause on, a second draft**

Update Skill handoff contracts so shopping_list may emit shopping_to_stock.v1 to inventory_analysis or food_profile. The receiving instruction must say:

1. Re-read the exact ingredient or Food by ID.
2. Present quantity, unit, and target for confirmation.
3. Create an inventory_operation or food_profile draft only after the user confirms the stock intake.
4. Never say inventory has changed before that second approval succeeds.

- [ ] **Step 6: Run streaming and approval regressions**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_approvals.py -q

Expected: both branches resume, exactly one draft exists per run, and the first approval never mutates stock.

- [ ] **Step 7: Commit**

    git add backend/app/ai/workflows/orchestrator/product_continuations.py backend/app/ai/skills/state_schemas.py backend/app/ai/skills/catalog/shopping-list backend/app/ai/skills/catalog/inventory-analysis backend/app/ai/skills/catalog/food-profile backend/app/ai/workflows/runner_support/approval_resume_handler.py backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_approvals.py
    git commit -m "feat(ai): continue completed shopping into stock intake"

---

### Task 3: Turn Recipe Shortages Into Real-ID Shopping Proposals

**Files:**
- Modify: backend/app/ai/skills/state_schemas.py
- Modify: backend/app/ai/skills/catalog/recipe-cook/skill.yaml
- Modify: backend/app/ai/skills/catalog/recipe-cook/SKILL.md
- Modify: backend/app/ai/skills/catalog/shopping-list/skill.yaml
- Modify: backend/app/ai/skills/catalog/shopping-list/SKILL.md
- Modify: backend/app/ai/tools/catalog/recipe.py
- Modify: backend/app/ai/workflows/orchestrator/product_continuations.py
- Test: backend/tests/ai_infra/test_product_closed_loops.py
- Test: backend/tests/ai_infra/test_workspace_approvals.py
- Test: backend/tests/recipes/test_recipe_cooking.py

**Interfaces:**
- Consumes: recipe.preview_cook shortages with real ingredient IDs and shortageType.
- Produces: recipe_shortage_to_shopping.v1 continuation to shopping_list.
- Terminates: after shopping-list draft approval; it does not automatically retry cooking.

- [ ] **Step 1: Add failing tests for quantitative and presence-only shortages**

    def test_recipe_shortage_handoff_preserves_real_ingredient_ids(self) -> None:
        preview = preview_recipe_with_shortages()
        continuation = preview["workflowContinuation"]
        assert continuation["stateSchema"] == "recipe_shortage_to_shopping.v1"
        assert continuation["nextSkillKey"] == "shopping_list"
        assert continuation["state"]["recipeId"] == self.recipe.id
        assert {
            row["ingredientId"] for row in continuation["state"]["shortages"]
        } == {self.tomato.id, self.salt.id}
        salt = next(row for row in continuation["state"]["shortages"] if row["ingredientId"] == self.salt.id)
        assert salt["shortageType"] == "presence"
        assert "quantity" not in salt

    def test_shortage_shopping_approval_does_not_retry_cook(self) -> None:
        result = approve_shortage_shopping_draft()
        assert "workflowContinuation" not in result
        assert recipe_cook_log_count(self.recipe.id) == 0

- [ ] **Step 2: Run the focused tests and confirm the handoff is missing**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py -k shortage -q

Expected: failures show no typed handoff and no shopping continuation state.

- [ ] **Step 3: Register recipe_shortage_to_shopping.v1**

Add strict Phase 2 state models. The model validator requires quantity and unit
only for quantitative shortages and forbids them for presence-only shortages:

    class RecipeShoppingShortage(ContinuationStateModel):
        ingredientId: EntityId
        ingredientName: ShortText
        shortageType: Literal["quantity", "presence"]
        quantity: QuantityText | None = None
        unit: ShortText | None = None

        @model_validator(mode="after")
        def validate_shortage_payload(self) -> "RecipeShoppingShortage":
            if self.shortageType == "quantity":
                valid = self.quantity is not None and self.unit is not None
            else:
                valid = self.quantity is None and self.unit is None
            if not valid:
                raise ValueError(
                    "quantity fields must match shortageType"
                )
            return self


    class RecipeShortageToShoppingState(ContinuationStateModel):
        recipeId: EntityId
        shortages: Annotated[
            list[RecipeShoppingShortage],
            Field(min_length=1, max_length=50),
        ]


    CONTINUATION_STATE_ADAPTERS[
        "recipe_shortage_to_shopping.v1"
    ] = TypeAdapter(RecipeShortageToShoppingState)
    CONTINUATION_STATE_SCHEMAS[
        "recipe_shortage_to_shopping.v1"
    ] = CONTINUATION_STATE_ADAPTERS[
        "recipe_shortage_to_shopping.v1"
    ].json_schema()

Normalize from preview output using a pure function:

    def build_recipe_shortage_state(
        *,
        recipe_id: str,
        shortages: list[dict[str, Any]],
    ) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        for shortage in shortages:
            row = {
                "ingredientId": require_string(shortage, "ingredient_id"),
                "ingredientName": require_string(shortage, "ingredient_name"),
                "shortageType": require_string(shortage, "shortage_type"),
            }
            if row["shortageType"] == "quantity":
                row["quantity"] = decimal_to_string(shortage["missing_quantity"])
                row["unit"] = require_string(shortage, "unit")
            rows.append(row)
        if not rows:
            raise ContinuationBuildError("recipe_has_no_shortage")
        return {"recipeId": recipe_id, "shortages": rows}

When the user accepts the shortage card, wrap this state in the eight-field v3
handoff payload and validate it with
`normalize_continuation(..., source_skill_key="recipe_cook")` before
injecting shopping_list.

- [ ] **Step 4: Expose an explicit add-shortages-to-shopping action after preview**

The recipe.preview_cook card must keep shortages visible and add one action that sends a normal user turn such as “把缺少的食材加入购物清单”. It must not create the draft directly from a card click. The resumed shopping Skill re-reads every ingredient by ID, skips already-satisfied open rows where appropriate, displays the proposed rows, and creates one shopping_list draft only after confirmation.

For presence-only ingredients, create the proposed shopping row with
quantityMode = not_track_quantity and displayLabel = 需要补充 while omitting
quantity and unit from the model-authored payload. The existing request model
normalizes that presence-only row to its internal sentinel values; the Skill
must not present those sentinels as a measured purchase quantity.

- [ ] **Step 5: Verify the loop and non-regression**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py backend/tests/recipes/test_recipe_cooking.py backend/tests/ai_infra/test_workspace_approvals.py -q

Expected: shortage identities survive the handoff, shopping requires approval, and no cook log or inventory deduction occurs.

- [ ] **Step 6: Commit**

    git add backend/app/ai/skills/state_schemas.py backend/app/ai/skills/catalog/recipe-cook backend/app/ai/skills/catalog/shopping-list backend/app/ai/tools/catalog/recipe.py backend/app/ai/workflows/orchestrator/product_continuations.py backend/tests/ai_infra/test_product_closed_loops.py backend/tests/recipes/test_recipe_cooking.py backend/tests/ai_infra/test_workspace_approvals.py
    git commit -m "feat(ai): route recipe shortages into shopping"

---

### Task 4: Add Optional Ready-Food Stock Deduction to AI Meal Logging

**Files:**
- Modify: backend/app/ai/tools/schemas.py
- Modify: backend/app/services/ai_operations/draft_specs/planning.py
- Modify: backend/app/services/ai_operations/meal_logs.py
- Modify: backend/app/ai/skills/catalog/meal-record/skill.yaml
- Modify: backend/app/ai/skills/catalog/meal-record/SKILL.md
- Modify: frontend/src/api/types.ts
- Modify: frontend/src/components/ai/AiApprovalFields.tsx
- Test: backend/tests/ai_infra/test_workspace_approvals.py
- Test: backend/tests/ai_infra/test_product_closed_loops.py
- Test: backend/tests/recipes/test_food_stock_operations.py
- Test: frontend/src/components/ai/AiApprovalPanel.test.tsx

**Interfaces:**
- Adds to each ready-food meal item: deductStock, stockQuantity, and stockUnit.
- Consumes: existing apply_food_stock_consume service.
- Transaction boundary: meal log creation and selected Food deduction commit or roll back together.

- [ ] **Step 1: Write failing approval and rollback tests**

    def test_approved_ai_meal_log_can_consume_ready_food_stock(self) -> None:
        draft = create_meal_log_draft(
            foods=[{
                "foodId": self.ready_food.id,
                "deductStock": True,
                "stockQuantity": "1",
                "stockUnit": "份",
            }]
        )
        approve(draft)
        assert meal_log_count() == 1
        assert food_stock(self.ready_food.id) == Decimal("2")

    def test_meal_log_rejects_stock_deduction_for_recipe_food(self) -> None:
        response = create_meal_log_draft(
            foods=[{
                "foodId": self.recipe_food.id,
                "deductStock": True,
                "stockQuantity": "1",
                "stockUnit": "份",
            }]
        )
        assert response.error_code == "food_stock_not_supported"

    def test_meal_log_and_stock_deduction_roll_back_together(self) -> None:
        force_stock_failure(self.ready_food.id)
        with pytest.raises(FoodStockError):
            approve(self.draft)
        assert meal_log_count() == 0
        assert food_stock(self.ready_food.id) == Decimal("3")

- [ ] **Step 2: Run the focused tests and confirm the fields are rejected**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py -k meal_log backend/tests/ai_infra/test_workspace_approvals.py -k meal_log -q

Expected: draft schema rejects deductStock or commit ignores the requested deduction.

- [ ] **Step 3: Extend the schema with conditional validation**

Add these optional properties to a Food item:

    "deductStock": {"type": "boolean", "default": False},
    "stockQuantity": {"type": "string", "pattern": "^[0-9]+(?:\\.[0-9]+)?$"},
    "stockUnit": {"type": "string", "minLength": 1},

When deductStock is true, stockQuantity and stockUnit are required. The draft-spec validator must re-read Food by family_id, require a ready-like category, require stockUnit to equal the Food's current non-empty stock_unit, and include current and post-approval stock in the preview. The model must never infer deduction merely because a ready Food appears in the meal.

- [ ] **Step 4: Apply deduction in the existing approval transaction**

Inside the meal-log commit service, load every deducting Food with
`select(Food).where(Food.family_id == family_id,
Food.id.in_(...)).with_for_update()`; reject the whole approval if any ID is
missing. After the log row is added but before `commit_session`:

    for item in validated_food_items:
        if not item.deduct_stock:
            continue
        apply_food_stock_consume(
            db,
            family_id=family_id,
            user_id=user_id,
            food=foods_by_id[item.food_id],
            quantity=item.stock_quantity,
            unit=item.stock_unit,
            note="AI 餐食记录 " + meal_log.id,
        )

The existing apply_food_stock_consume path flushes but does not commit. Keep the
single commit_session call at the end of the approval commit service so meal
creation and all selected deductions roll back together.

- [ ] **Step 5: Add explicit approval controls**

In AiApprovalFields.tsx, show a checkbox only for ready-like Food items. Enabling it reveals quantity and unit fields and updates submittedValues. Default is unchecked. Add accessible labels and preserve the existing approval layout.

- [ ] **Step 6: Run backend and frontend regressions**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/recipes/test_food_stock_operations.py -q
    npm --prefix frontend run test -- AiApprovalPanel

Expected: transactional tests, unsupported-Food rejection, and UI submission tests pass.

- [ ] **Step 7: Commit**

    git add backend/app/ai/tools/schemas.py backend/app/services/ai_operations/draft_specs/planning.py backend/app/services/ai_operations/meal_logs.py backend/app/ai/skills/catalog/meal-record frontend/src/api/types.ts frontend/src/components/ai/AiApprovalFields.tsx backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/recipes/test_food_stock_operations.py frontend/src/components/ai/AiApprovalPanel.test.tsx
    git commit -m "feat(ai): support approved meal stock deduction"

---

### Task 5: Apply the Same Current-Message Attachment Contract to Recipe and Meal Drafts

**Files:**
- Modify: backend/app/ai/skills/catalog/recipe-draft/skill.yaml
- Modify: backend/app/ai/skills/catalog/recipe-draft/SKILL.md
- Modify: backend/app/ai/skills/catalog/meal-record/skill.yaml
- Modify: backend/app/ai/skills/catalog/meal-record/SKILL.md
- Modify: backend/app/ai/workflows/runner_support/attachments.py
- Modify: backend/app/services/ai_operations/draft_specs/recipes.py
- Modify: backend/app/services/ai_operations/draft_specs/planning.py
- Test: backend/tests/ai_infra/test_multimodal_attachments.py
- Test: backend/tests/ai_infra/test_product_closed_loops.py

**Interfaces:**
- Consumes: provider payload currentAttachments entries with mediaId and content metadata.
- Produces: recipe or meal draft media_ids that are a subset of the current message attachment IDs.

- [ ] **Step 1: Add failing valid, stale, and cross-family attachment tests**

    def test_recipe_draft_accepts_current_message_media(self) -> None:
        result = run_recipe_draft_with_attachment(self.current_media)
        assert result["draft"]["payload"]["media_ids"] == [self.current_media.id]

    @pytest.mark.parametrize("source", ["previous_message", "other_family", "unknown"])
    def test_recipe_and_meal_drafts_reject_non_current_media(self, source: str) -> None:
        response = create_draft_with_media(media_id_for(source))
        assert response.error_code == "invalid_current_attachment"

- [ ] **Step 2: Run tests and confirm recipe or meal media binding is unguarded**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_multimodal_attachments.py -q

Expected: at least recipe and meal coverage fails because the shared subset validation is incomplete.

- [ ] **Step 3: Centralize current-message media validation**

Add one shared function:

    def validate_current_attachment_ids(
        db: Session,
        *,
        family_id: str,
        requested_media_ids: Sequence[str],
        current_attachments: Sequence[Mapping[str, Any]],
    ) -> list[str]:
        allowed = {
            str(item["mediaId"])
            for item in current_attachments
            if isinstance(item, Mapping) and item.get("mediaId")
        }
        normalized = unique_strings(requested_media_ids)
        if any(media_id not in allowed for media_id in normalized):
            raise DraftValidationError("invalid_current_attachment")
        owned = set(
            db.scalars(
                select(MediaAsset.id).where(
                    MediaAsset.id.in_(normalized),
                    MediaAsset.family_id == family_id,
                )
            )
        )
        if owned != set(normalized):
            raise DraftValidationError("invalid_current_attachment")
        return normalized

Thread currentAttachments into draft validation through trusted run context; do not accept a model-supplied allowlist.

- [ ] **Step 4: Update both Skill attachment policies**

Set acceptsCurrentAttachments to true and allowedPurposes to ["entity_reference", "meal_evidence"] where appropriate. Instructions must distinguish “use this image as the saved recipe or meal evidence” from a contextual photo that should not be persisted.

- [ ] **Step 5: Verify all four image-capable Skills**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_product_closed_loops.py -q

Expected: ingredient, Food, recipe, and meal drafts all enforce the same current-message and family boundary.

- [ ] **Step 6: Commit**

    git add backend/app/ai/skills/catalog/recipe-draft backend/app/ai/skills/catalog/meal-record backend/app/ai/workflows/runner_support/attachments.py backend/app/services/ai_operations/draft_specs/recipes.py backend/app/services/ai_operations/draft_specs/planning.py backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_product_closed_loops.py
    git commit -m "feat(ai): bind recipe and meal drafts to current media"

---

### Task 6: Add Reviewable Fridge and Receipt Intake Candidates

**Files:**
- Create: backend/app/ai/tools/catalog/inventory_intake.py
- Create: frontend/src/components/ai/AiInventoryIntakeCandidates.tsx
- Create: frontend/src/components/ai/AiProductLoopCards.test.tsx
- Modify: backend/app/ai/tools/catalog/__init__.py
- Modify: backend/app/ai/tools/registry.py
- Modify: backend/app/ai/skills/catalog/inventory-analysis/skill.yaml
- Modify: backend/app/ai/skills/catalog/inventory-analysis/SKILL.md
- Modify: backend/app/ai/skills/state_schemas.py
- Modify: backend/app/schemas/ai.py
- Modify: frontend/src/api/types.ts
- Modify: frontend/src/components/ai/AiResultCards.tsx
- Modify: frontend/src/components/ai/AiConversationThread.tsx
- Modify: frontend/src/components/ai/AiMobilePage.tsx
- Modify: frontend/src/components/ai/AiWorkspace.tsx
- Modify: frontend/src/lib/aiWorkspaceContracts.ts
- Modify: frontend/src/lib/aiWorkspaceContracts.test.ts
- Test: backend/tests/ai_infra/test_product_closed_loops.py

**Interfaces:**
- Produces: inventory_intake_candidates output card with current-family ingredient IDs and editable proposed quantities.
- Card action produces: a normal user message plus selected candidate payload; it never commits inventory.
- Missing identities produce: inventory_missing_ingredient.v1 to ingredient_profile, one ingredient draft at a time.

- [ ] **Step 1: Write failing Tool and card tests**

    def test_inventory_intake_preview_rejects_unknown_ingredient_id(tool_context) -> None:
        with pytest.raises(ToolExecutionError, match="ingredient_not_found"):
            execute_preview_intake_candidates(
                tool_context,
                {"items": [{"ingredientId": "made-up", "quantity": "1", "unit": "盒"}]},
            )

    def test_inventory_intake_preview_returns_review_card(tool_context) -> None:
        result = execute_preview_intake_candidates(
            tool_context,
            {"items": [{"ingredientId": self.tomato.id, "quantity": "2", "unit": "个"}]},
        )
        assert result["card"]["type"] == "inventory_intake_candidates"
        assert result["card"]["data"]["items"][0]["ingredientId"] == self.tomato.id

Frontend:

    expect(screen.getByRole("button", { name: "按选中项准备入库" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "按选中项准备入库" }))
    expect(onSendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ quickTask: "inventory_analysis" }),
    )

- [ ] **Step 2: Run the focused tests and confirm the card type is unknown**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py -k intake -q
    npm --prefix frontend run test -- AiProductLoopCards

Expected: Tool registration and renderer tests fail.

- [ ] **Step 3: Implement a read-only validation and preview Tool**

The Tool input requires items with ingredientId and optionally quantity, unit, confidence, and sourceLabel. It must:

1. De-duplicate ingredient IDs.
2. Re-read all rows using family_id.
3. Validate quantity-tracking and unit compatibility.
4. Return canonical name, quantity mode, normalized quantity, normalized unit, and warnings.
5. Return unresolved labels separately without inventing IDs.

The Tool does not run image recognition itself; the provider interprets the current image and must resolve candidates through ingredient.search or ingredient.resolve_candidates before calling this validator.

Add inventory_intake_candidates to AIResultCardType and the frontend contract
literal. Its DTO requires items with ingredientId, name, quantityMode,
quantity, unit, selected, warnings, and optional confidence/sourceLabel, plus
an unresolvedLabels array. Set additional model fields to forbidden so an
unvalidated image label cannot leak into a candidate row.

Register inventory.preview_intake_candidates with side_effect = read,
terminal_output = true, and output_types = ["inventory_intake_candidates"].
Declare the same output type and terminal Tool in inventory-analysis/skill.yaml
so the result card satisfies v3 completion policy.

- [ ] **Step 4: Implement the selectable card and explicit continuation**

Register the continuation state:

    class InventoryIntakeResolvedItem(ContinuationStateModel):
        ingredientId: EntityId
        quantity: QuantityText | None = None
        unit: ShortText | None = None


    class InventoryMissingIngredientState(ContinuationStateModel):
        currentLabel: ShortText
        pendingLabels: Annotated[
            list[ShortText],
            Field(max_length=30),
        ]
        resolvedItems: Annotated[
            list[InventoryIntakeResolvedItem],
            Field(max_length=30),
        ]


    CONTINUATION_STATE_ADAPTERS[
        "inventory_missing_ingredient.v1"
    ] = TypeAdapter(InventoryMissingIngredientState)
    CONTINUATION_STATE_SCHEMAS[
        "inventory_missing_ingredient.v1"
    ] = CONTINUATION_STATE_ADAPTERS[
        "inventory_missing_ingredient.v1"
    ].json_schema()

Declare an inventory_analysis to ingredient_profile handoff with
resume_skill = inventory_analysis. The frontend card keeps selection and
editable quantity locally. Pressing the action sends the selected real IDs back
as user-controlled subject.extra.intakeCandidates. The next run validates them
again and may create one inventory_operation draft. Unknown labels enter this
continuation and resume intake only after each approved ingredient exists.

Define the shared callback as:

    export interface AiProductLoopPrompt {
      message: string;
      quick_task: 'inventory_analysis' | 'recipe_draft';
      subject: Record<string, unknown>;
    }

    onProductLoopPrompt?: (
      prompt: AiProductLoopPrompt,
    ) => void;

Pass it from AiWorkspace through AiMobilePage or AiConversationThread to
ResultCard. Change submitComposerMessage to accept an optional second argument
with quick_task and subject, and forward both to chatMutation.mutateAsync. The
intake card calls it with:

    onProductLoopPrompt?.({
      message: '按这些项目准备入库',
      quick_task: 'inventory_analysis',
      subject: {
        source: 'inventory_intake_candidates',
        extra: { intakeCandidates: selectedItems },
      },
    });

- [ ] **Step 5: Verify backend, frontend, and attachment behavior**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_multimodal_attachments.py -q
    npm --prefix frontend run test -- AiProductLoopCards AiWorkspace

Expected: candidate cards never write inventory, IDs are family-scoped, and user-selected candidates survive the next run.

- [ ] **Step 6: Commit**

    git add backend/app/ai/tools/catalog/inventory_intake.py backend/app/ai/tools/catalog/__init__.py backend/app/ai/tools/registry.py backend/app/ai/skills/catalog/inventory-analysis backend/app/ai/skills/state_schemas.py backend/app/schemas/ai.py frontend/src/api/types.ts frontend/src/lib/aiWorkspaceContracts.ts frontend/src/lib/aiWorkspaceContracts.test.ts frontend/src/components/ai/AiInventoryIntakeCandidates.tsx frontend/src/components/ai/AiProductLoopCards.test.tsx frontend/src/components/ai/AiResultCards.tsx frontend/src/components/ai/AiConversationThread.tsx frontend/src/components/ai/AiMobilePage.tsx frontend/src/components/ai/AiWorkspace.tsx backend/tests/ai_infra/test_product_closed_loops.py
    git commit -m "feat(ai): add reviewable inventory intake candidates"

---

### Task 7: Propose Inventory-Backed Meal Ideas When the Food and Recipe Library Is Empty

**Files:**
- Create: backend/app/ai/tools/catalog/meal_ideas.py
- Create: frontend/src/components/ai/AiMealIdeaProposal.tsx
- Modify: backend/app/ai/tools/catalog/__init__.py
- Modify: backend/app/ai/tools/registry.py
- Modify: backend/app/ai/skills/catalog/meal-planning/skill.yaml
- Modify: backend/app/ai/skills/catalog/meal-planning/SKILL.md
- Modify: backend/app/ai/skills/catalog/recipe-draft/skill.yaml
- Modify: backend/app/ai/skills/catalog/recipe-draft/SKILL.md
- Modify: backend/app/schemas/ai.py
- Modify: frontend/src/api/types.ts
- Modify: frontend/src/components/ai/AiResultCards.tsx
- Modify: frontend/src/components/ai/AiProductLoopCards.test.tsx
- Modify: frontend/src/lib/aiWorkspaceContracts.ts
- Modify: frontend/src/lib/aiWorkspaceContracts.test.ts
- Test: backend/tests/ai_infra/test_product_closed_loops.py

**Interfaces:**
- Produces: meal_idea_proposal card based only on real current-family ingredient IDs.
- Produces on user action: a meal_idea_subject.v1 user-controlled subject routed to recipe_draft.
- Does not produce: a fake Food ID, Recipe ID, or meal-plan entry.

- [ ] **Step 1: Add failing empty-library and non-empty-library tests**

    def test_empty_library_returns_inventory_backed_idea_card(tool_context) -> None:
        result = execute_propose_meal_idea(
            tool_context,
            {
                "title": "番茄鸡蛋汤",
                "ingredientIds": [self.tomato.id, self.egg.id],
                "reason": "现有库存可以组合",
            },
        )
        assert result["card"]["type"] == "meal_idea_proposal"
        assert "foodId" not in result["card"]["data"]
        assert "recipeId" not in result["card"]["data"]

    def test_meal_plan_uses_real_library_candidate_when_available(self) -> None:
        result = run_meal_plan_request_with_existing_recipe()
        assert result.selected_recipe_id == self.recipe.id
        assert result.tool_calls.count("meal_plan.propose_from_inventory") == 0

- [ ] **Step 2: Run tests and confirm the proposal Tool is missing**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py -k meal_idea -q

Expected: failures show no Tool and no output-card contract.

- [ ] **Step 3: Implement validation and the proposal card**

meal_plan.propose_from_inventory accepts title, ingredientIds, reason, and optional preparationSummary. It re-reads ingredients within the family, rejects an empty or partially invalid list, and returns canonical ingredient names and current inventory sufficiency. It is a proposal Tool, not a draft Tool.

Add meal_idea_proposal to the backend and frontend card literals. Its strict
DTO requires title, reason, ingredientIds, ingredient summaries, and
preparationSummary, and explicitly has no foodId or recipeId property.

Register meal_plan.propose_from_inventory with side_effect = read,
terminal_output = true, and output_types = ["meal_idea_proposal"]. Declare the
same output type and terminal Tool in meal-planning/skill.yaml.

The meal-planning Skill may call it only after Food and Recipe searches both produce no suitable real candidates. If suitable real entities exist, normal meal-plan drafting remains preferred.

- [ ] **Step 4: Continue accepted ideas into recipe drafting**

This transition starts a new user turn rather than an approval continuation,
because the proposal itself has not committed a business write. Store this
strict card-action shape under subject.extra.mealIdea:

    {
      schemaVersion: 'meal_idea_subject.v1',
      title: card.data.title,
      ingredientIds: card.data.ingredientIds,
      reason: card.data.reason,
      preparationSummary: card.data.preparationSummary,
    }

recipe_draft must treat it as a proposal, re-read every ingredient ID inside
the current family, and ask again if any ID no longer resolves. The recipe
still requires its own approval before a later meal plan may reference it.

The action uses the callback established in Task 6:

    onProductLoopPrompt?.({
      message: '把这个想法整理成菜谱',
      quick_task: 'recipe_draft',
      subject: {
        source: 'meal_idea_proposal',
        ingredient_ids: card.data.ingredientIds,
        extra: {
          mealIdea: {
            schemaVersion: 'meal_idea_subject.v1',
            title: card.data.title,
            ingredientIds: card.data.ingredientIds,
            reason: card.data.reason,
            preparationSummary:
              card.data.preparationSummary,
          },
        },
      },
    });

- [ ] **Step 5: Verify no fake entity enters a meal plan**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_product_closed_loops.py backend/tests/ai_infra/test_workspace_approvals.py -q
    npm --prefix frontend run test -- AiProductLoopCards AiWorkspace

Expected: empty-library ideas remain proposals, existing real candidates are preferred, and recipe creation requires approval.

- [ ] **Step 6: Commit**

    git add backend/app/ai/tools/catalog/meal_ideas.py backend/app/ai/tools/catalog/__init__.py backend/app/ai/tools/registry.py backend/app/ai/skills/catalog/meal-planning backend/app/ai/skills/catalog/recipe-draft backend/app/schemas/ai.py frontend/src/api/types.ts frontend/src/lib/aiWorkspaceContracts.ts frontend/src/lib/aiWorkspaceContracts.test.ts frontend/src/components/ai/AiMealIdeaProposal.tsx frontend/src/components/ai/AiProductLoopCards.test.tsx frontend/src/components/ai/AiResultCards.tsx backend/tests/ai_infra/test_product_closed_loops.py
    git commit -m "feat(ai): add inventory backed meal idea proposals"

---

### Task 8: Document and Gate the Whole Product Loop Phase

**Files:**
- Modify: docs/ai-assistant-standards.md
- Modify: backend/tests/ai_infra/test_skill_loader.py
- Modify: backend/tests/ai_infra/test_registry_and_metrics.py
- Modify: frontend/src/lib/aiWorkspaceContracts.test.ts

**Interfaces:**
- Verifies: all cross-Skill handoffs are declared, registered, family-scoped, and approval-gated.
- Documents: exact terminal condition for each product loop.

- [ ] **Step 1: Add contract inventory tests**

Assert these exact approval-continuation edges:

    shopping_list -> inventory_analysis using shopping_to_stock.v1
    shopping_list -> food_profile using shopping_to_stock.v1
    recipe_cook -> shopping_list using recipe_shortage_to_shopping.v1
    inventory_analysis -> ingredient_profile using inventory_missing_ingredient.v1

Separately assert the non-writing card transition:

    meal_idea_proposal action -> recipe_draft using meal_idea_subject.v1

Also assert that no handoff commits a draft and that all frontend output card types match backend literals.

- [ ] **Step 2: Update the assistant standard**

Document, per loop:

1. Trigger and source artifact.
2. State schema and real-ID requirements.
3. Receiving Skill.
4. Approval boundary.
5. Terminal condition.
6. Failure and cancellation behavior.

- [ ] **Step 3: Run the full phase verification**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra backend/tests/family/test_family_api.py backend/tests/recipes/test_recipe_cooking.py backend/tests/recipes/test_food_stock_operations.py -q
    npm --prefix frontend run test
    npm --prefix frontend run build
    git diff --check

Expected: all backend AI, family, cooking, stock, and frontend tests pass; the frontend build succeeds; no whitespace errors remain.

- [ ] **Step 4: Commit**

    git add docs/ai-assistant-standards.md backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_registry_and_metrics.py frontend/src/lib/aiWorkspaceContracts.test.ts
    git commit -m "docs(ai): define product loop completion contracts"

---

## Phase Exit Criteria

- A completed ingredient or Food shopping item can lead to a separately approved stock intake without double-writing.
- Recipe shortages can lead to a real-ID shopping draft and never imply that cooking has already become possible.
- AI meal logging can optionally and transactionally consume ready-food stock, with an unchecked default.
- Recipe and meal drafts can persist only current-message, current-family media.
- Fridge or receipt interpretation produces reviewable candidates before an inventory draft.
- Empty Food and Recipe libraries produce an inventory-backed idea proposal, never a fabricated entity.
- Family preferences and safe member context are available to the relevant Skills without sensitive account fields.
- The full verification command is green and each task has an independent commit.
