from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ._support import AIAgentInfraTestCase

from app.models.domain import AIAutoExecutionPreference, AIFamilyAutoExecutionPolicy
from app.services.ai_auto_execution.policy_registry import AutoExecutionPolicyRegistry
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    CriticalEvidenceRequirement,
    EffectiveAuthorization,
    IntentEvidenceValidation,
)
from app.services.ai_auto_execution.settings import resolve_effective_authorization
from app.services.ai_operations.registry import draft_operation_registry

class _FakeActionPolicy:
    key = "test.safe_action"
    version = "test.safe_action.v1"
    draft_types = frozenset({"test_draft"})
    revert_adapter_key = "test.safe_action.revert.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return draft_type in self.draft_types and payload.get("action") == "safe_action"

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]:
        del db, family_id, actor_user_id, payload
        return (
            CriticalEvidenceRequirement("action", "meal_plan.simple_create", "explicit_action"),
        )

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        target_state = context.payload.get("target_state")
        if target_state == "partial":
            return ActionPolicyEvaluation(
                allowed=False,
                all_targets_satisfied=False,
                reason_codes=("domain_constraint_failed",),
            )
        return ActionPolicyEvaluation(
            allowed=True,
            all_targets_satisfied=target_state == "already_satisfied",
            reason_codes=tuple(context.payload.get("policy_reasons", ())),
        )


class _OverlappingPolicy(_FakeActionPolicy):
    key = "test.overlap"
    version = "test.overlap.v1"


@pytest.fixture
def registry() -> AutoExecutionPolicyRegistry:
    return AutoExecutionPolicyRegistry((_FakeActionPolicy(),))


@pytest.fixture
def base_context() -> AutoExecutionPolicyContext:
    return AutoExecutionPolicyContext(
        db=object(),  # type: ignore[arg-type]
        family_id="family-ai",
        actor_user_id="user-ai",
        draft_type="test_draft",
        payload={"action": "safe_action"},
        evidence=IntentEvidenceValidation(
            clarity="explicit_complete",
            normalized_evidence={},
            verified_fields=frozenset({"action"}),
            verified_values={"action": "safe_action"},
        ),
        authorization=EffectiveAuthorization(
            enabled=True,
            source="catalog_default",
            snapshot={"source": "catalog_default", "catalog_version": "auto-execution.v1"},
            reason_codes=(),
        ),
        auto_execution_attempted=False,
        has_continuation=False,
        is_composite=False,
        has_external_side_effect=False,
        registered_revert_adapters=frozenset({_FakeActionPolicy.revert_adapter_key}),
    )


@pytest.mark.parametrize(
    ("override", "reason"),
    [
        ({"evidence": replace(
            IntentEvidenceValidation("explicit_complete", {}, frozenset(), {}),
            clarity="inferred",
        )}, "intent_not_explicit"),
        ({"evidence": IntentEvidenceValidation(
            "explicit_complete", {}, frozenset(), {}, ("source_quote_mismatch",),
        )}, "source_quote_mismatch"),
        ({"evidence": IntentEvidenceValidation(
            "explicit_complete", {}, frozenset(), {}, ("source_value_unverifiable",),
        )}, "source_value_unverifiable"),
        ({"evidence": IntentEvidenceValidation(
            "explicit_complete", {}, frozenset(), {}, ("source_value_mismatch",),
        )}, "source_value_mismatch"),
        ({"authorization": EffectiveAuthorization(
            False, None, {}, ("action_not_allowed",),
        )}, "action_not_allowed"),
        ({"registered_revert_adapters": frozenset()}, "revert_adapter_missing"),
        ({"has_continuation": True}, "continuation_not_allowed"),
        ({"is_composite": True}, "composite_not_allowed"),
        ({"auto_execution_attempted": True}, "auto_execution_already_attempted"),
    ],
)
def test_global_gate_downgrades_to_manual(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
    override: dict[str, Any],
    reason: str,
) -> None:
    decision = registry.evaluate(replace(base_context, **override))

    assert decision.route == "manual_confirmation"
    assert reason in decision.reason_codes


def test_external_side_effect_is_not_auto_executed(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    decision = registry.evaluate(replace(base_context, has_external_side_effect=True))

    assert decision.route == "manual_confirmation"
    assert decision.reason_codes == ("domain_constraint_failed",)


def test_unauthorized_already_satisfied_target_still_requires_confirmation(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    context = replace(
        base_context,
        authorization=EffectiveAuthorization(
            False, None, {}, ("action_not_allowed",),
        ),
        payload={"action": "safe_action", "target_state": "already_satisfied"},
    )

    decision = registry.evaluate(context)

    assert decision.route == "manual_confirmation"
    assert decision.reason_codes == ("action_not_allowed",)


def test_only_fully_authorized_satisfied_target_returns_no_change(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    decision = registry.evaluate(replace(
        base_context,
        payload={"action": "safe_action", "target_state": "already_satisfied"},
    ))

    assert decision.route == "no_change"
    assert decision.reason_codes == ("target_already_satisfied",)


def test_allowed_unsatisfied_target_returns_auto_execute(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    decision = registry.evaluate(base_context)

    assert decision.route == "auto_execute"
    assert decision.policy_key == _FakeActionPolicy.key
    assert decision.policy_version == _FakeActionPolicy.version
    assert decision.authorization_source == "catalog_default"


def test_partial_satisfaction_is_manual(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    decision = registry.evaluate(replace(
        base_context,
        payload={"action": "safe_action", "target_state": "partial"},
    ))

    assert decision.route == "manual_confirmation"
    assert decision.reason_codes == ("domain_constraint_failed",)


def test_reason_codes_are_deduplicated_without_losing_gate_order(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    evidence = IntentEvidenceValidation(
        clarity="inferred",
        normalized_evidence={},
        verified_fields=frozenset(),
        verified_values={},
        reason_codes=("source_quote_mismatch", "source_quote_mismatch"),
    )
    authorization = EffectiveAuthorization(
        enabled=False,
        source=None,
        snapshot={},
        reason_codes=("source_quote_mismatch", "action_not_allowed"),
    )
    decision = registry.evaluate(replace(
        base_context,
        evidence=evidence,
        authorization=authorization,
        registered_revert_adapters=frozenset(),
        has_continuation=True,
        is_composite=True,
        auto_execution_attempted=True,
        payload={
            "action": "safe_action",
            "policy_reasons": ("action_not_allowed", "target_stale"),
        },
    ))

    assert decision.reason_codes == (
        "intent_not_explicit",
        "source_quote_mismatch",
        "action_not_allowed",
        "revert_adapter_missing",
        "continuation_not_allowed",
        "composite_not_allowed",
        "auto_execution_already_attempted",
        "target_stale",
    )


def test_no_or_non_unique_matching_policy_is_not_allowed(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    no_match = registry.evaluate(replace(base_context, payload={"action": "unknown"}))
    ambiguous = AutoExecutionPolicyRegistry((_FakeActionPolicy(), _OverlappingPolicy())).evaluate(base_context)

    assert no_match.route == "manual_confirmation"
    assert no_match.reason_codes == ("action_not_allowed",)
    assert ambiguous.route == "manual_confirmation"
    assert ambiguous.reason_codes == ("action_not_allowed",)


def test_policy_metadata_is_server_owned(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    decision = registry.evaluate(replace(
        base_context,
        payload={
            "action": "safe_action",
            "auto_execution_policy_key": "attacker.policy",
            "revert_adapter_key": "attacker.revert",
        },
    ))

    assert decision.policy_key == _FakeActionPolicy.key
    assert decision.policy_version == _FakeActionPolicy.version


def test_resolve_then_validate_uses_policy_requirements_before_global_gates(
    registry: AutoExecutionPolicyRegistry,
    base_context: AutoExecutionPolicyContext,
) -> None:
    evidence, decision = registry.evaluate_draft(
        db=base_context.db,
        family_id=base_context.family_id,
        actor_user_id=base_context.actor_user_id,
        draft_type=base_context.draft_type,
        payload=base_context.payload,
        evidence_input={
            "intentClarity": "explicit_complete",
            "sourceQuotes": [{"fields": ["action"], "text": "安排到计划"}],
            "resolutionSources": [],
            "ambiguityCodes": [],
            "defaultedFields": [],
        },
        current_message="安排到计划",
        trusted_resolution_sources={},
        authorization=base_context.authorization,
        auto_execution_attempted=False,
        has_continuation=False,
        is_composite=False,
        has_external_side_effect=False,
        registered_revert_adapters=base_context.registered_revert_adapters,
    )

    assert evidence.verified_fields == frozenset({"action"})
    assert decision.route == "auto_execute"


class AIAutoExecutionAuthorizationResolverTestCase(AIAgentInfraTestCase):
    def test_catalog_action_is_enabled_by_default_without_creating_setting_rows(self) -> None:
        with self.SessionLocal() as db:
            authorization = resolve_effective_authorization(
                db,
                family_id=self.family.id,
                actor_user_id=self.user.id,
                action_key="shopping_list.safe_write",
                policy_version="shopping_list.safe_write.v1",
                for_update=False,
            )
            self.assertTrue(authorization.enabled)
            self.assertEqual(authorization.source, "catalog_default")
            self.assertEqual(authorization.reason_codes, ())
            self.assertEqual(authorization.snapshot, {
                "source": "catalog_default",
                "action_key": "shopping_list.safe_write",
                "catalog_version": "auto-execution.v1",
                "policy_version": "shopping_list.safe_write.v1",
            })
            self.assertEqual(db.scalar(select(func.count(AIAutoExecutionPreference.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIFamilyAutoExecutionPolicy.id))), 0)

    def test_legacy_disabled_rows_do_not_override_catalog_default(self) -> None:
        with self.SessionLocal() as db:
            db.add_all([
                AIAutoExecutionPreference(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    action_key="shopping_list.safe_write",
                    enabled=False,
                    consent_notice_version="auto-execution-consent.v0",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                ),
                AIFamilyAutoExecutionPolicy(
                    family_id=self.family.id,
                    action_key="shopping_list.safe_write",
                    enabled=False,
                    consent_notice_version="auto-execution-consent.v0",
                    consented_by=self.user.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                ),
            ])
            db.flush()

            authorization = resolve_effective_authorization(
                db,
                family_id=self.family.id,
                actor_user_id=self.user.id,
                action_key="shopping_list.safe_write",
                policy_version="shopping_list.safe_write.v1",
                for_update=True,
            )

            self.assertTrue(authorization.enabled)
            self.assertEqual(authorization.source, "catalog_default")
            self.assertEqual(authorization.reason_codes, ())
            self.assertEqual(authorization.snapshot, {
                "source": "catalog_default",
                "action_key": "shopping_list.safe_write",
                "catalog_version": "auto-execution.v1",
                "policy_version": "shopping_list.safe_write.v1",
            })

    def test_action_outside_catalog_is_not_authorized(self) -> None:
        with self.SessionLocal() as db:
            authorization = resolve_effective_authorization(
                db,
                family_id=self.family.id,
                actor_user_id=self.user.id,
                action_key="inventory.consume",
                policy_version="inventory.consume.v1",
                for_update=False,
            )
            self.assertFalse(authorization.enabled)
            self.assertIsNone(authorization.source)
            self.assertEqual(authorization.reason_codes, ("action_not_allowed",))
            self.assertEqual(authorization.snapshot, {
                "source": None,
                "action_key": "inventory.consume",
                "catalog_version": "auto-execution.v1",
                "policy_version": "inventory.consume.v1",
            })


def test_existing_draft_specs_default_to_manual_server_metadata() -> None:
    for draft_type in draft_operation_registry.keys():
        spec = draft_operation_registry.get(draft_type)
        assert spec.auto_execution_policy_key is None, draft_type
        assert spec.revert_adapter_key is None, draft_type
