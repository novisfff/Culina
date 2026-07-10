# AI Skill Phase 2 Contract v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Culina Skills from prompt-oriented v2 packages to a backward-compatible v3 runtime contract with separate routing/execution records, validated handoffs, typed approval continuation, attachment policies, and batch candidate resolution.

**Architecture:** Keep the single `WorkspaceOrchestratorAgent` and existing Tool/draft/approval boundaries. Extend Skill manifests with machine-readable routing, handoff, and attachment policies; validate those contracts at catalog load time; persist continuation in existing `AITaskDraft.ai_metadata`; and resume through typed artifacts without introducing a generic workflow database.

**Tech Stack:** Python 3.12, dataclasses, PyYAML, JSON Schema, FastAPI, SQLAlchemy 2 JSON columns, LangGraph, pytest.

## Global Constraints

- Keep stable Skill keys, route hints, draft types, schema versions, approval types, and commit handler keys unchanged.
- v2 and v3 packages must load together during migration.
- Existing persisted `afterApproval` metadata must remain readable until all pending approvals created before deployment can finish.
- New model-facing draft tools must expose `continuation`, not free-form `nextDraftType`.
- Runtime may inject the next Skill after approval, but it must never generate or commit the next draft automatically.
- Every handoff target must be allowed by the active Orchestrator Profile and current Skill budget.
- Continuation state must be compact orchestration state, not a second copy of full recipe, meal-plan, or shopping payloads.
- Candidate resolution remains read-only; semantic search is recall only and never final identity binding.
- Missing ingredients remain sequential: explain the overall gap, then create one confirmable ingredient draft at a time.
- No database migration and no new third-party dependency in this phase.
- All final verification commands actually run during implementation must be reported.

---

## File Structure

Create:

- `backend/app/ai/skills/contracts.py`: v3 routing, handoff, and attachment dataclasses.
- `backend/app/ai/skills/state_schemas.py`: registered JSON Schemas for continuation state.
- `backend/app/ai/workflows/orchestrator/continuation.py`: validation, normalization, resume artifact, and idempotency helpers.
- `backend/app/ai/tools/catalog/resolution.py`: batch ingredient and purchasable candidate read tools.
- `backend/tests/ai_infra/test_skill_contract_v3.py`: loader, record split, handoff, continuation, and batch resolution tests.

Modify:

- `backend/app/ai/skills/base.py`: attach v3 policies to `SkillManifest` and split records.
- `backend/app/ai/skills/loader.py`: parse v2/v3 and validate cross-Skill contracts.
- `backend/app/ai/skills/registry.py`: validate references after all packages are registered.
- `backend/app/ai/workflows/orchestrator/skill_injection.py`: use routing records before injection and execution records after injection.
- `backend/app/ai/workflows/orchestrator/payloads.py`: feed the appropriate record shape to prompts.
- `backend/app/ai/runtime/tooling.py`: expose the typed `continuation` wrapper.
- `backend/app/ai/workflows/orchestrator/draft_capture.py`: normalize continuation before publishing a draft.
- `backend/app/ai/workflows/runner_support/approval_resume.py`: produce typed workflow continuation artifacts.
- `backend/app/ai/workflows/runner_support/approval_resume_handler.py`: inject validated next Skills only after successful approval commit.
- `backend/app/ai/workflows/compact_context.py`: preserve compact continuation state.
- `backend/app/ai/tools/catalog/__init__.py`: register resolution tools.
- `backend/app/ai/tools/registry.py`: include resolution tools in the workspace registry.
- `backend/app/ai/skills/catalog/*/skill.yaml`: migrate all nine packages to v3.
- `backend/app/ai/skills/catalog/*/SKILL.md`: adopt the common query/propose/mutate and handoff structure.
- `docs/ai-assistant-standards.md`: document v3 package and continuation contracts.
- Existing AI infrastructure tests listed in the tasks below.

---

### Task 1: Define the v3 Contract Types and Record Split

**Files:**
- Create: `backend/app/ai/skills/contracts.py`
- Modify: `backend/app/ai/skills/base.py`
- Test: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Produces: `SkillRoutingPolicy`, `SkillHandoffPolicy`, `SkillAttachmentPolicy`, `SkillManifest.to_routing_record()`, and `SkillManifest.to_execution_record()`.
- Consumed by: loader, prompt payload builder, continuation validator, and diagnostics.

- [ ] **Step 1: Write failing record-shape tests**

Create `backend/tests/ai_infra/test_skill_contract_v3.py`:

```python
from __future__ import annotations

from app.ai.skills.registry import build_workspace_skill_registry


def test_routing_record_excludes_execution_only_contracts() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest

    record = manifest.to_routing_record()

    assert record["key"] == "shopping_list"
    assert "routing" in record
    assert "toolBudget" not in record
    assert "completionPolicy" not in record
    assert "draftContract" not in record
    assert "allowedTools" not in record


def test_execution_record_contains_machine_contracts() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest

    record = manifest.to_execution_record()

    assert record["allowedTools"] == manifest.tools
    assert record["draftContract"] == manifest.draft_contract
    assert record["handoffs"] == manifest.handoffs_record()
```

- [ ] **Step 2: Run the tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: fail because the v3 policy types and record methods do not exist.

- [ ] **Step 3: Create focused contract dataclasses**

Create `backend/app/ai/skills/contracts.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class SkillRoutingPolicy:
    modes: tuple[str, ...] = ()
    include_examples: tuple[str, ...] = ()
    exclude_examples: tuple[str, ...] = ()
    conflict_rules: tuple[dict[str, str], ...] = ()

    def to_record(self) -> dict[str, Any]:
        return {
            "modes": list(self.modes),
            "includeExamples": list(self.include_examples),
            "excludeExamples": list(self.exclude_examples),
            "conflictRules": [dict(item) for item in self.conflict_rules],
        }


@dataclass(frozen=True, slots=True)
class SkillHandoffPolicy:
    reason_code: str
    target_skill: str
    required_draft_type: str
    resume_skill: str
    state_schema: str

    def to_record(self) -> dict[str, str]:
        return {
            "reasonCode": self.reason_code,
            "targetSkill": self.target_skill,
            "requiredDraftType": self.required_draft_type,
            "resumeSkill": self.resume_skill,
            "stateSchema": self.state_schema,
        }


@dataclass(frozen=True, slots=True)
class SkillAttachmentPolicy:
    accepted_kinds: tuple[str, ...] = ()
    usages: tuple[str, ...] = ()
    bindable_fields: tuple[str, ...] = ()
    current_message_only: bool = True
    explicit_user_intent_required: bool = True

    def to_record(self) -> dict[str, Any]:
        return {
            "acceptedKinds": list(self.accepted_kinds),
            "usages": list(self.usages),
            "bindableFields": list(self.bindable_fields),
            "currentMessageOnly": self.current_message_only,
            "explicitUserIntentRequired": self.explicit_user_intent_required,
        }
```

- [ ] **Step 4: Extend `SkillManifest` without breaking v2 callers**

Add these fields to `SkillManifest` in `backend/app/ai/skills/base.py`:

```python
contract_version: int = 2
routing: SkillRoutingPolicy = field(default_factory=SkillRoutingPolicy)
handoffs: dict[str, SkillHandoffPolicy] = field(default_factory=dict)
attachment_policy: SkillAttachmentPolicy = field(default_factory=SkillAttachmentPolicy)
```

Add imports from `app.ai.skills.contracts` and these methods:

```python
def handoffs_record(self) -> dict[str, dict[str, str]]:
    return {reason: policy.to_record() for reason, policy in self.handoffs.items()}

def to_routing_record(self) -> dict[str, Any]:
    return {
        "key": self.key,
        "displayName": self.name,
        "description": self.description,
        "routing": self.routing.to_record(),
        "outputs": self.output_types,
        "draftTypes": self.draft_types,
        "routeHints": self.route_hints,
        "requiresApproval": self.approval_policy == "draft_then_confirm",
    }

def to_execution_record(self) -> dict[str, Any]:
    return {
        **self.to_routing_record(),
        "contractVersion": self.contract_version,
        "allowedTools": self.tools,
        "scriptFiles": self.script_files,
        "toolBudget": self.tool_budget,
        "completionPolicy": self.completion_policy.to_catalog_record(),
        "draftContract": self.draft_contract,
        "approvalPolicy": self.approval_policy,
        "handoffs": self.handoffs_record(),
        "attachmentPolicy": self.attachment_policy.to_record(),
    }
```

Keep `to_catalog_record()` as a compatibility alias returning `to_execution_record()` until Phase 4 removes remaining callers.

- [ ] **Step 5: Run tests and commit**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_skill_loader.py -q
```

Expected: all selected tests pass after fixtures receive default v2 policies.

```bash
git add backend/app/ai/skills/contracts.py backend/app/ai/skills/base.py backend/tests/ai_infra/test_skill_contract_v3.py
git commit -m "feat: define AI skill contract v3 records"
```

---

### Task 2: Parse and Validate v2/v3 Manifests

**Files:**
- Create: `backend/app/ai/skills/state_schemas.py`
- Modify: `backend/app/ai/skills/loader.py`
- Modify: `backend/app/ai/skills/registry.py`
- Test: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Consumes: `routing`, `handoffs`, and `attachment_policy` YAML mappings.
- Produces: `SkillRegistry.validate_contracts(tool_registry) -> None` and `CONTINUATION_STATE_SCHEMAS`.

- [ ] **Step 1: Add failing loader cases**

Add this explicit temporary-package helper and first failure case to
`backend/tests/ai_infra/test_skill_contract_v3.py`:

```python
import yaml

from app.ai.skills.loader import SkillDirectoryLoader
from app.ai.skills.registry import SkillRegistry
from app.ai.tools.registry import build_workspace_tool_registry


def load_v3_registry(
    tmp_path: Path,
    *,
    handoffs: dict[str, dict[str, str]],
) -> SkillRegistry:
    skill_dir = tmp_path / "source-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: source-skill\n"
        "description: Temporary v3 source skill.\n"
        "---\n"
        "# Source\n",
        encoding="utf-8",
    )
    runtime = {
        "version": 3,
        "key": "source_skill",
        "display_name": "Source Skill",
        "approval_policy": "none",
        "allowed_tools": [],
        "draft_types": [],
        "output_types": [],
        "routing": {
            "modes": ["default"],
            "include_examples": ["source request"],
            "exclude_examples": [],
            "conflict_rules": [],
        },
        "handoffs": handoffs,
        "attachment_policy": {
            "accepts_current_attachments": False,
            "allowed_purposes": [],
        },
    }
    (skill_dir / "skill.yaml").write_text(
        yaml.safe_dump(runtime, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    tool_registry = build_workspace_tool_registry()
    registry = SkillRegistry()
    for skill in SkillDirectoryLoader(
        tmp_path,
        tool_registry=tool_registry,
    ).load():
        registry.register(skill)
    registry.validate_contracts(tool_registry)
    return registry


def test_v3_loader_rejects_unknown_handoff_target(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown target Skill"):
        load_v3_registry(
            tmp_path,
            handoffs={
                "missing_item": {
                    "target_skill": "missing_skill",
                    "required_draft_type": "ingredient_profile",
                    "resume_skill": "source_skill",
                    "state_schema": "recipe_missing_ingredient.v1",
                }
            },
        )
```

Also add explicit cases for duplicate include/exclude examples, missing routing modes, unknown state schema, and a handoff draft type not declared by the target Skill.

- [ ] **Step 2: Run loader tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: fail because v3 YAML is rejected and cross-Skill validation is absent.

- [ ] **Step 3: Register compact continuation schemas**

Create `backend/app/ai/skills/state_schemas.py`:

```python
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


EntityId = Annotated[str, Field(min_length=1, max_length=64)]
ShortText = Annotated[str, Field(min_length=1, max_length=120)]
Instruction = Annotated[str, Field(min_length=1, max_length=500)]
IsoDate = Annotated[
    str,
    Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$"),
]


class ContinuationStateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RecipeMissingIngredientState(ContinuationStateModel):
    recipeTitle: ShortText
    currentIngredient: ShortText
    pendingIngredientNames: Annotated[
        list[ShortText],
        Field(max_length=30),
    ]
    completedIngredientIds: Annotated[
        list[EntityId],
        Field(max_length=50),
    ]


class ShoppingMissingTargetState(ContinuationStateModel):
    currentTargetName: ShortText
    pendingTargetNames: Annotated[
        list[ShortText],
        Field(max_length=50),
    ]
    resolvedTargetIds: Annotated[
        list[EntityId],
        Field(max_length=50),
    ]


class FoodToMealPlanState(ContinuationStateModel):
    targetDate: IsoDate
    mealType: Literal["breakfast", "lunch", "dinner", "snack"]
    instruction: Instruction


CONTINUATION_STATE_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "recipe_missing_ingredient.v1": TypeAdapter(
        RecipeMissingIngredientState
    ),
    "shopping_missing_target.v1": TypeAdapter(
        ShoppingMissingTargetState
    ),
    "food_to_meal_plan.v1": TypeAdapter(FoodToMealPlanState),
}

CONTINUATION_STATE_SCHEMAS: dict[str, dict[str, Any]] = {
    key: adapter.json_schema()
    for key, adapter in CONTINUATION_STATE_ADAPTERS.items()
}


def validate_continuation_state(
    schema_key: str,
    state: dict[str, Any],
) -> dict[str, Any]:
    adapter = CONTINUATION_STATE_ADAPTERS.get(schema_key)
    if adapter is None:
        raise ValueError(
            f"Unknown continuation state schema: {schema_key}"
        )
    validated = adapter.validate_python(state, strict=True)
    return validated.model_dump(mode="json")
```

- [ ] **Step 4: Parse v3 policies in the loader**

Update `_validate_v2_runtime()` to accept `{2, 3, "2", "3"}` and rename it `_validate_runtime_version()`. Add focused parsing methods:

```python
def _routing_policy(self, value: Any, *, version: int, examples: list[str]) -> SkillRoutingPolicy:
    if version == 2:
        return SkillRoutingPolicy(modes=("default",), include_examples=tuple(examples))
    if not isinstance(value, dict):
        raise ValueError("skill.yaml routing must be a mapping for version 3")
    modes = tuple(self._list(value.get("modes"), field_name="routing.modes"))
    includes = tuple(self._list(value.get("include_examples"), field_name="routing.include_examples"))
    excludes = tuple(self._list(value.get("exclude_examples"), field_name="routing.exclude_examples"))
    if not modes:
        raise ValueError("skill.yaml routing.modes must not be empty")
    overlap = sorted(set(includes).intersection(excludes))
    if overlap:
        raise ValueError(f"routing include/exclude examples overlap: {', '.join(overlap)}")
    raw_conflicts = value.get("conflict_rules") or []
    if not isinstance(raw_conflicts, list) or not all(isinstance(item, dict) for item in raw_conflicts):
        raise ValueError("skill.yaml routing.conflict_rules must be a list of mappings")
    return SkillRoutingPolicy(
        modes=modes,
        include_examples=includes,
        exclude_examples=excludes,
        conflict_rules=tuple({str(key): str(item[key]) for key in item} for item in raw_conflicts),
    )
```

Implement equivalent `_handoff_policies()` and `_attachment_policy()` parsers that construct the dataclasses from Task 1. Store `contract_version=int(version)` on `SkillManifest`.

- [ ] **Step 5: Validate cross-Skill references after registry construction**

Add `SkillRegistry.validate_contracts(tool_registry)`:

```python
def validate_contracts(self, tool_registry) -> None:
    for skill in self.list():
        manifest = skill.manifest
        for reason, handoff in manifest.handoffs.items():
            if handoff.target_skill not in self._skills:
                raise ValueError(f"Skill {manifest.key} handoff {reason} references unknown target Skill {handoff.target_skill}")
            if handoff.resume_skill not in self._skills:
                raise ValueError(f"Skill {manifest.key} handoff {reason} references unknown resume Skill {handoff.resume_skill}")
            target = self.get(handoff.target_skill).manifest
            if handoff.required_draft_type not in target.draft_types:
                raise ValueError(
                    f"Skill {manifest.key} handoff {reason} requires undeclared target draft type {handoff.required_draft_type}"
                )
            if handoff.state_schema not in CONTINUATION_STATE_SCHEMAS:
                raise ValueError(f"Skill {manifest.key} handoff {reason} references unknown state schema {handoff.state_schema}")
```

Call it after all catalog packages register in `build_workspace_skill_registry()`.

- [ ] **Step 6: Run tests and commit**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_skill_loader.py -q
```

Expected: v2 compatibility and v3 validation tests pass.

```bash
git add backend/app/ai/skills/state_schemas.py backend/app/ai/skills/loader.py backend/app/ai/skills/registry.py backend/tests/ai_infra/test_skill_contract_v3.py
git commit -m "feat: load and validate skill contract v3"
```

---

### Task 3: Use Routing Records Before Injection and Execution Records After Injection

**Files:**
- Modify: `backend/app/ai/workflows/orchestrator/skill_injection.py`
- Modify: `backend/app/ai/workflows/orchestrator/payloads.py`
- Modify: `backend/tests/ai_infra/test_orchestrator_profiles.py`
- Modify: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Produces: `SkillInjectionManager.routing_records(policy)` and execution records in `SkillInjectionBundle`.

- [ ] **Step 1: Write failing prompt-boundary tests**

Assert the initial main-workspace prompt contains `"routing"` but not `"toolBudget"`, while an injected Skill record contains `"allowedTools"` and `"handoffs"`.

```python
prompt = builder.system_prompt(context, [])
assert '"routing"' in prompt
assert '"toolBudget"' not in prompt

injected_prompt = builder.system_prompt(context, ["shopping_list"])
assert '"allowedTools"' in injected_prompt
assert '"handoffs"' in injected_prompt
```

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_orchestrator_profiles.py -q
```

Expected: initial catalog still contains execution-only fields.

- [ ] **Step 3: Split manager record methods**

Replace `catalog_records()` with:

```python
def routing_records(
    self,
    capability_policy: OrchestratorCapabilityPolicy | None = None,
) -> list[dict[str, Any]]:
    return [
        manifest.to_routing_record()
        for manifest in self.skill_registry.list_manifests()
        if capability_policy is None or capability_policy.allows_skill(manifest.key)
    ]
```

Set `SkillInjectionBundle.manifest_record=manifest.to_execution_record()` in `bundle_for()`.

Update `OrchestratorPromptPayloadBuilder.system_prompt()` to pass `routing_records(...)` as `catalog_records`.

- [ ] **Step 4: Run profile and foundation tests**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_skill_contract_v3.py \
  backend/tests/ai_infra/test_orchestrator_profiles.py \
  backend/tests/ai_infra/test_foundation.py -q
```

Expected: all tests pass; fixed cooking profile still hides the main catalog.

- [ ] **Step 5: Commit**

```bash
git add backend/app/ai/workflows/orchestrator/skill_injection.py backend/app/ai/workflows/orchestrator/payloads.py backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_orchestrator_profiles.py
git commit -m "refactor: separate skill routing and execution records"
```

---

### Task 4: Validate Typed Continuation at Draft Capture

**Files:**
- Create: `backend/app/ai/workflows/orchestrator/continuation.py`
- Modify: `backend/app/ai/runtime/tooling.py`
- Modify: `backend/app/ai/workflows/orchestrator/draft_capture.py`
- Test: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Produces: `ContinuationRequest`, `normalize_continuation(...) -> dict[str, Any]`, and `CONTINUATION_INPUT_SCHEMA`.
- Consumes: active Skill keys, profile capability policy, Skill Registry, current attachments, and the configured state schema.

- [ ] **Step 1: Write failing continuation validation tests**

Cover valid, unknown reason, unknown next Skill, wrong draft type, mismatched state schema, invalid state payload, and disallowed profile cases. The valid assertion is:

```python
normalized = normalize_continuation(
    payload={
        "workflowId": "workflow-recipe-1",
        "stepKey": "ingredient-1",
        "reasonCode": "missing_ingredient",
        "nextSkillKey": "ingredient_profile",
        "resumeSkillKey": "recipe_draft",
        "requiredDraftType": "ingredient_profile",
        "stateSchema": "recipe_missing_ingredient.v1",
        "state": {
            "recipeTitle": "番茄鸡蛋面",
            "currentIngredient": "碱水面",
            "pendingIngredientNames": ["碱水面"],
            "completedIngredientIds": [],
        },
    },
    source_skill_key="recipe_draft",
    skill_registry=registry,
    capability_policy=MAIN_WORKSPACE_PROFILE.capability_policy,
)
assert normalized["status"] == "pending"
```

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: fail because continuation validation does not exist.

- [ ] **Step 3: Implement continuation schema and validator**

Create `backend/app/ai/workflows/orchestrator/continuation.py` with a frozen dataclass containing these exact fields:

```python
@dataclass(frozen=True, slots=True)
class ContinuationRequest:
    workflow_id: str
    step_key: str
    reason_code: str
    next_skill_key: str
    resume_skill_key: str
    required_draft_type: str
    state_schema: str
    state: dict[str, Any]
```

Define `CONTINUATION_INPUT_SCHEMA` with camelCase JSON properties, `additionalProperties: False`, and all eight fields required. Implement `normalize_continuation()` to:

1. Identify the source Skill handoff by `reasonCode`.
2. Compare all target/resume/draft/schema fields with that handoff.
3. Check `capability_policy.allows_skill()` for both target and resume Skills.
4. Validate and normalize `state` with
   `validate_continuation_state(request.state_schema, request.state)`.
5. Return the original camelCase fields, the normalized state, plus
   `status="pending"` and `version=1`.

Use the Phase 2 Pydantic adapters in
`app.ai.skills.state_schemas`; do not add a JSON Schema dependency. Convert
`pydantic.ValidationError` into the existing stable draft-validation error
shape:

```python
try:
    normalized_state = validate_continuation_state(
        request.state_schema,
        request.state,
    )
except ValidationError as exc:
    raise ContinuationValidationError(
        code="invalid_continuation_state",
        details=[
            {
                "path": ".".join(str(part) for part in error["loc"]),
                "message": error["msg"],
            }
            for error in exc.errors(include_url=False)
        ],
    ) from exc
```

- [ ] **Step 4: Expose `continuation` to draft tools**

In `backend/app/ai/runtime/tooling.py`, replace the model-facing `afterApproval` property with:

```python
"continuation": CONTINUATION_INPUT_SCHEMA,
```

Keep legacy `afterApproval` parsing only inside approval resume compatibility code; do not expose it in new provider tool schemas.

- [ ] **Step 5: Capture normalized continuation**

Rename `PreparedToolPayload.after_approval` to `continuation`. In `prepare_tool_payload()`, read `payload.get("continuation")`. Before publishing, call `normalize_continuation()` with the Skill owning the draft tool. Store:

```python
draft_record = {
    "draft_type": draft_type,
    "payload": draft,
    "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
    "tool": tool_name,
    "continuation": normalized_continuation,
}
```

Pass the registry and capability policy into `prepare_tool_payload()` from the existing orchestrator tool gateway.

- [ ] **Step 6: Run tests and commit**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_foundation.py -q
```

Expected: validation and provider schema tests pass.

```bash
git add backend/app/ai/workflows/orchestrator/continuation.py backend/app/ai/runtime/tooling.py backend/app/ai/workflows/orchestrator/draft_capture.py backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_foundation.py
git commit -m "feat: validate typed AI draft continuation"
```

---

### Task 5: Persist and Resume Continuation Safely

**Files:**
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/app/ai/workflows/runner_support/approval_resume.py`
- Modify: `backend/app/ai/workflows/runner_support/approval_resume_handler.py`
- Modify: `backend/app/ai/workflows/compact_context.py`
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**
- Consumes: `AITaskDraft.ai_metadata["continuation"]`, successful approval operation output, and active Skill state.
- Produces: `workflow.continuation` artifacts and exactly-once Skill resume.

- [ ] **Step 1: Write approval, rejection, conflict, and replay tests**

Add integration tests asserting:

```python
assert stored_draft.ai_metadata["continuation"]["workflowId"] == "workflow-recipe-1"
assert resume_artifact["type"] == "workflow.continuation"
assert resume_artifact["status"] == "ready"
assert resume_artifact["payload"]["businessEntityIds"] == [created_ingredient.id]
assert "recipe_draft" in resumed_state["injected_skill_keys"]
```

Add separate tests that rejection emits `status="rejected"`, a commit conflict emits no ready artifact, and replaying the same approval keeps one continuation artifact.

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/ai_infra/test_workspace_streaming.py -q
```

Expected: continuation metadata and artifacts are absent.

- [ ] **Step 3: Persist continuation in draft metadata**

In the progressive draft publisher path in `workspace_service.py`, write:

```python
ai_metadata = {
    **existing_metadata,
    **({"continuation": draft_record["continuation"]} if draft_record.get("continuation") else {}),
}
```

Continue reading legacy `afterApproval` metadata for already stored drafts.

- [ ] **Step 4: Create typed resume artifacts**

Add to `approval_resume.py`:

```python
def continuation_artifact(
    *,
    run_id: str,
    approval_id: str,
    continuation: dict[str, Any],
    decision_status: str,
    business_entity_ids: list[str],
) -> dict[str, Any]:
    artifact_status = "ready" if decision_status == "approved" else "rejected"
    return {
        "id": f"workflow_continuation:{continuation['workflowId']}:{continuation['stepKey']}:{approval_id}",
        "type": "workflow.continuation",
        "kind": "task_resume",
        "version": 1,
        "status": artifact_status,
        "sourceApprovalId": approval_id,
        "payload": {
            **continuation,
            "status": artifact_status,
            "businessEntityIds": list(dict.fromkeys(business_entity_ids)),
            "sourceRunId": run_id,
        },
    }
```

- [ ] **Step 5: Inject the resume Skill only after successful commit**

In `approval_resume_handler.py`, after the operation is flushed and the approval checkpoint is committed:

```python
if continuation and serialized["approval"]["status"] == "approved":
    resume_key = str(continuation["resumeSkillKey"])
    injected_skill_keys = list(dict.fromkeys([*state.get("injected_skill_keys", []), resume_key]))
else:
    injected_skill_keys = list(state.get("injected_skill_keys") or [])
```

Before appending, rebuild the policy and budget from the persisted profile
state and use this exact guard:

```python
profile_state = state.get("orchestrator_profile") or {}
capability_policy = OrchestratorCapabilityPolicy.from_state(
    profile_state_value(
        profile_state,
        "capabilityPolicy",
        "capability_policy",
    )
)
budget = OrchestratorBudgetConfig.from_state(
    profile_state_value(
        profile_state,
        "budgetConfig",
        "budget_config",
    )
).for_capability_policy(capability_policy)
business_keys = [
    key
    for key in injected_skill_keys
    if key != "cooking_assistant"
]
if not capability_policy.allows_skill(resume_key):
    raise ContinuationResumeError(
        "continuation_skill_not_allowed"
    )
if (
    resume_key not in business_keys
    and len(business_keys)
    >= budget.max_business_skills_per_run
):
    raise ContinuationResumeError(
        "continuation_skill_budget_exhausted"
    )
```

On either error, leave the approved business commit intact, mark the
continuation artifact failed with that stable code, and do not start another
model round.

- [ ] **Step 6: Compact continuation without copying full business drafts**

In `compact_context.py`, add a `workflow.continuation` branch that retains only:

```python
{
    "workflowId": payload.get("workflowId"),
    "stepKey": payload.get("stepKey"),
    "reasonCode": payload.get("reasonCode"),
    "nextSkillKey": payload.get("nextSkillKey"),
    "resumeSkillKey": payload.get("resumeSkillKey"),
    "stateSchema": payload.get("stateSchema"),
    "state": _compact_plain_dict(payload.get("state") or {}),
    "businessEntityIds": list(payload.get("businessEntityIds") or [])[:20],
}
```

- [ ] **Step 7: Run approval tests and commit**

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/ai_infra/test_workspace_streaming.py \
  backend/tests/ai_infra/test_foundation.py -q
```

Expected: approval, rejection, conflict, and replay tests pass.

```bash
git add backend/app/ai/workspace_service.py backend/app/ai/workflows/runner_support/approval_resume.py backend/app/ai/workflows/runner_support/approval_resume_handler.py backend/app/ai/workflows/compact_context.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "feat: resume typed AI skill continuations"
```

---

### Task 6: Add Batch Candidate Resolution Tools

**Files:**
- Create: `backend/app/ai/tools/catalog/resolution.py`
- Modify: `backend/app/ai/tools/catalog/__init__.py`
- Modify: `backend/app/ai/tools/registry.py`
- Modify: `backend/app/ai/skills/catalog/recipe-draft/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/shopping-list/skill.yaml`
- Test: `backend/tests/ai_infra/test_tool_registry.py`
- Test: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Produces: `ingredient.resolve_candidates` and `purchasable.resolve_candidates` read tools.
- Consumes: existing exact-family SQL queries and `hybrid_search()`.

- [ ] **Step 1: Write failing registry and family-isolation tests**

Assert both tools register as `read`, return no draft types, reject more than 30 inputs, and never return another family's Ingredient or Food. Assert each result status is one of `exact`, `candidate`, `ambiguous`, or `missing`.

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: unknown Tool failures.

- [ ] **Step 3: Implement batch resolution**

Create `resolution.py` with one shared input schema:

```python
RESOLVE_CANDIDATES_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 30,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["clientKey", "name"],
                "properties": {
                    "clientKey": {"type": "string", "minLength": 1, "maxLength": 64},
                    "name": {"type": "string", "minLength": 1, "maxLength": 120},
                },
            },
        },
        "limitPerItem": {"type": "integer", "minimum": 1, "maximum": 5},
    },
}
```

For each item:

- return `exact` only when normalized names match exactly;
- return `candidate` for one semantic candidate;
- return `ambiguous` for multiple plausible candidates;
- return `missing` for none.

Every candidate must include `id`, `name`, `targetType`, `matchType`, and `matchReason`. Ingredient candidates additionally include `defaultUnit`, `supportedUnits`, and `quantityTrackingMode`; Food candidates include `foodType`, `stockUnit`, and `storageLocation`. `purchasable.resolve_candidates` must filter Food types to `readyMade`, `instant`, and `packaged`.

- [ ] **Step 4: Register and authorize the tools**

Register both tools in the workspace Tool Registry. Add `ingredient.resolve_candidates` to `recipe_draft`; add `purchasable.resolve_candidates` to `shopping_list`. Add completion policy hints that require the model to ask on `ambiguous` and hand off on `missing`.

- [ ] **Step 5: Run tests and commit**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: all tests pass, including cross-family exclusion.

```bash
git add backend/app/ai/tools/catalog/resolution.py backend/app/ai/tools/catalog/__init__.py backend/app/ai/tools/registry.py backend/app/ai/skills/catalog/recipe-draft/skill.yaml backend/app/ai/skills/catalog/shopping-list/skill.yaml backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_skill_contract_v3.py
git commit -m "feat: add batch AI entity candidate resolution"
```

---

### Task 7: Migrate All Catalog Packages to v3

**Files:**
- Modify: `backend/app/ai/skills/catalog/*/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/*/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/meal-planning/references/workflows.md`
- Modify: `backend/app/ai/skills/catalog/shopping-list/references/workflows.md`
- Modify: `docs/ai-assistant-standards.md`
- Test: `backend/tests/ai_infra/test_skill_loader.py`
- Test: `backend/tests/ai_infra/test_skill_contract_v3.py`

**Interfaces:**
- Consumes: all v3 contract parsers and continuation schemas.
- Produces: nine `version: 3` packages with explicit modes, examples, conflicts, handoffs, and attachment policies.

- [ ] **Step 1: Add migration assertions**

Assert all nine manifests have `contract_version == 3`, non-empty routing modes, and no include/exclude overlap. Assert the following handoffs exactly:

```python
expected = {
    "recipe_draft": {"missing_ingredient": ("ingredient_profile", "recipe_draft")},
    "meal_plan": {"missing_food": ("food_profile", "meal_plan")},
    "shopping_list": {
        "missing_ingredient": ("ingredient_profile", "shopping_list"),
        "missing_ready_food": ("food_profile", "shopping_list"),
    },
    "inventory_analysis": {
        "missing_ingredient": ("ingredient_profile", "inventory_analysis"),
        "save_unit_conversion": ("ingredient_profile", "inventory_analysis"),
        "ready_food_stock": ("food_profile", "food_profile"),
    },
    "meal_log": {"missing_food": ("food_profile", "meal_log")},
    "food_profile": {"plan_after_create": ("meal_plan", "meal_plan")},
}
```

- [ ] **Step 2: Run tests and verify failure**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: v2 manifests fail the v3 migration assertion.

- [ ] **Step 3: Add routing policies**

For every `skill.yaml`, set `version: 3` and add `routing`. Use these exact modes:

```yaml
# food_profile, ingredient_profile, recipe_draft, shopping_list, meal_log, meal_plan
modes: [query, create, update]

# inventory_analysis
modes: [query, restock, consume, dispose]

# recipe_cook
modes: [preview, execute]

# cooking_assistant
modes: [answer, ui_action]
```

Add each Skill's existing `examples` to `include_examples`, then add at least three negative examples covering its two closest conflicting Skills. Keep machine `route_hints` unchanged.

- [ ] **Step 4: Add handoff and attachment policies**

Encode the handoff matrix asserted in Step 1. Use:

- `recipe_missing_ingredient.v1` for recipe missing ingredients;
- `shopping_missing_target.v1` for shopping missing targets;
- `food_to_meal_plan.v1` for Food-to-plan continuation.

Set image bind policies only for `food_profile`, `ingredient_profile`, `recipe_draft`, and `meal_log`. Set `current_message_only: true` and `explicit_user_intent_required: true` for every bindable attachment.

- [ ] **Step 5: Rewrite Skill docs around modes and handoffs**

Give every `SKILL.md` these sections in this order:

```markdown
## 用户目标
## 不适用范围
## 工作模式
## 前置条件
## 候选处理
## Handoff
## 审批规则
## 用户反馈
```

Move branching detail into the existing `references/workflows.md` files for meal planning and shopping. Preserve the real-ID, presence-only, approval, and sequential missing-ingredient rules verbatim in meaning.

- [ ] **Step 6: Document v3**

Update `docs/ai-assistant-standards.md` with the Routing Record, Execution Record, handoff, attachment, and continuation contracts. Explicitly state that JSON Schema and Pydantic remain the field-validation source of truth.

- [ ] **Step 7: Run migration tests and commit**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_skill_contract_v3.py -q
```

Expected: all nine packages load as v3 and all reference validation passes.

```bash
git add backend/app/ai/skills/catalog docs/ai-assistant-standards.md backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_skill_contract_v3.py
git commit -m "refactor: migrate Culina AI skills to contract v3"
```

---

### Task 8: Contract v3 End-to-End Regression Gate

**Files:**
- Modify only scoped Contract v3 files when a regression is proven.

**Interfaces:**
- Consumes: all Phase 2 tasks.
- Produces: a verified v3 baseline for product closed-loop work.

- [ ] **Step 1: Run the complete AI infrastructure suite**

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
```

Expected: all tests pass.

- [ ] **Step 2: Run the full backend suite**

```bash
npm run backend:test
```

Expected: all backend tests pass.

- [ ] **Step 3: Run frontend AI contracts and build**

```bash
npm --prefix frontend run test -- src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiConversationThread.test.tsx
npm --prefix frontend run build
```

Expected: tests and production build pass.

- [ ] **Step 4: Validate diffs and loader output**

```bash
backend/.venv/bin/python -c 'from app.ai.skills.registry import build_workspace_skill_registry; r=build_workspace_skill_registry(); print([(m.key, m.contract_version) for m in r.list_manifests()])'
git diff --check
git status --short
```

Expected: nine `(skill_key, 3)` pairs; no whitespace errors; only intended files remain.

- [ ] **Step 5: Commit regression-only corrections**

If verification required a scoped correction:

```bash
git add backend/app/ai backend/tests/ai_infra docs/ai-assistant-standards.md frontend/src/lib
git commit -m "test: close AI skill contract v3 regressions"
```

If no correction was required, do not create an empty commit.

---

## Phase 2 Exit Criteria

- All nine Skills use `version: 3`.
- Initial catalog prompts contain routing records only.
- Injected Skills receive complete execution records.
- Every declared handoff target, draft type, resume Skill, and state schema is load-time validated.
- New draft tools expose typed `continuation`; old stored `afterApproval` remains readable only for compatibility.
- Approved continuation resumes exactly once; rejection and conflict do not advance.
- Batch resolution reduces repeated searches without auto-binding semantic candidates.
- Missing ingredients still use real family IDs and sequential user approvals.
- No new workflow database table exists.
- Full backend and focused frontend AI tests pass.
