from __future__ import annotations

from collections.abc import Iterable
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.services.ai_auto_execution.intent_evidence import validate_intent_evidence
from app.services.ai_auto_execution.policies import build_action_policies
from app.services.ai_auto_execution.policy_types import (
    AutoExecutionActionPolicy,
    AutoExecutionDecision,
    AutoExecutionPolicyContext,
    EffectiveAuthorization,
    IntentEvidenceValidation,
    TrustedResolutionSource,
    ConcurrencyStrategy,
)


logger = logging.getLogger(__name__)


def _deduplicate_reason_codes(reason_codes: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(code for code in reason_codes if code))


class AutoExecutionPolicyRegistry:
    def __init__(self, policies: Iterable[AutoExecutionActionPolicy]) -> None:
        self._policies = tuple(policies)
        keys = [policy.key for policy in self._policies]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate auto-execution policy keys registered")

    def resolve_policy(
        self,
        *,
        draft_type: str,
        payload: dict[str, Any],
    ) -> AutoExecutionActionPolicy | None:
        matches = tuple(
            policy
            for policy in self._policies
            if draft_type in policy.draft_types
            and policy.matches(draft_type=draft_type, payload=payload)
        )
        return matches[0] if len(matches) == 1 else None

    def supports_draft_type(self, draft_type: str) -> bool:
        return any(draft_type in policy.draft_types for policy in self._policies)

    def concurrency_strategy(
        self,
        *,
        policy_key: str | None,
        policy_version: str | None,
        draft_type: str,
        payload: dict[str, Any],
    ) -> ConcurrencyStrategy:
        """Return the server-owned concurrency contract for one policy action.

        A payload never selects its own strategy.  The caller must provide the
        policy key captured during policy evaluation; a missing or mismatched
        key deliberately falls back to the strict entity-version contract.
        """
        if not policy_key or not policy_version:
            return "entity_version"
        policy = next((item for item in self._policies if item.key == policy_key), None)
        if (
            policy is None
            or policy.version != policy_version
            or draft_type not in policy.draft_types
            or not policy.matches(draft_type=draft_type, payload=payload)
        ):
            return "entity_version"
        resolver = getattr(policy, "concurrency_strategy", None)
        if not callable(resolver):
            return "entity_version"
        strategy = resolver(draft_type=draft_type, payload=payload)
        return strategy if strategy in {
            "entity_version",
            "field_patch",
            "idempotent_set",
            "insert",
        } else "entity_version"

    def evaluate(self, context: AutoExecutionPolicyContext) -> AutoExecutionDecision:
        policy = self.resolve_policy(
            draft_type=context.draft_type,
            payload=context.payload,
        )
        if policy is None:
            return AutoExecutionDecision(
                route="manual_confirmation",
                policy_key=None,
                policy_version=None,
                reason_codes=("action_not_allowed",),
            )

        action_evaluation = policy.evaluate(context)
        reason_codes: list[str] = []
        if context.evidence.clarity not in {"explicit_complete", "explicit_context_resolved"}:
            reason_codes.append("intent_not_explicit")
        reason_codes.extend(context.evidence.reason_codes)
        reason_codes.extend(context.authorization.reason_codes)
        if not context.authorization.enabled and not context.authorization.reason_codes:
            reason_codes.append("action_not_allowed")
        if policy.revert_adapter_key not in context.registered_revert_adapters:
            reason_codes.append("revert_adapter_missing")
        if context.has_external_side_effect:
            reason_codes.append("domain_constraint_failed")
        if context.has_continuation:
            reason_codes.append("continuation_not_allowed")
        if context.is_composite:
            reason_codes.append("composite_not_allowed")
        if context.auto_execution_attempted:
            reason_codes.append("auto_execution_already_attempted")
        reason_codes.extend(action_evaluation.reason_codes)
        if not action_evaluation.allowed and not action_evaluation.reason_codes:
            reason_codes.append("domain_constraint_failed")
        reasons = _deduplicate_reason_codes(reason_codes)

        decision_kwargs = {
            "policy_key": policy.key,
            "policy_version": policy.version,
            "authorization_source": context.authorization.source,
            "authorization_snapshot": dict(context.authorization.snapshot),
        }
        if reasons or not action_evaluation.allowed:
            return AutoExecutionDecision(
                route="manual_confirmation",
                reason_codes=reasons or ("domain_constraint_failed",),
                **decision_kwargs,
            )
        if action_evaluation.all_targets_satisfied:
            return AutoExecutionDecision(
                route="no_change",
                reason_codes=("target_already_satisfied",),
                **decision_kwargs,
            )
        return AutoExecutionDecision(
            route="auto_execute",
            reason_codes=(),
            **decision_kwargs,
        )

    def recheck_no_change_under_lock(
        self,
        *,
        context: AutoExecutionPolicyContext,
        expected_policy_key: str | None,
        expected_policy_version: str | None,
    ) -> AutoExecutionDecision:
        """Let the resolved action policy lock its targets, then rerun the same decision."""
        policy = self.resolve_policy(
            draft_type=context.draft_type,
            payload=context.payload,
        )
        if (
            policy is None
            or policy.key != expected_policy_key
            or policy.version != expected_policy_version
        ):
            return _manual_no_change_decision(
                policy_key=expected_policy_key,
                policy_version=expected_policy_version,
                authorization=context.authorization,
                reason_code="no_change_target_lock_unavailable",
            )
        try:
            locked = policy.lock_no_change_targets(context)
        except Exception:
            logger.warning(
                "AI no-change target lock failed closed family_id=%s policy_key=%s",
                context.family_id,
                policy.key,
                exc_info=True,
            )
            locked = False
        if not locked:
            return _manual_no_change_decision(
                policy_key=policy.key,
                policy_version=policy.version,
                authorization=context.authorization,
                reason_code="target_changed_before_no_change",
            )
        decision = self.evaluate(context)
        if (
            decision.route == "no_change"
            and decision.policy_key == expected_policy_key
            and decision.policy_version == expected_policy_version
        ):
            return decision
        return AutoExecutionDecision(
            route="manual_confirmation",
            policy_key=policy.key,
            policy_version=policy.version,
            reason_codes=_deduplicate_reason_codes(
                (*decision.reason_codes, "target_changed_before_no_change")
            ),
            authorization_source=decision.authorization_source,
            authorization_snapshot=dict(decision.authorization_snapshot),
        )

    def evaluate_draft(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        draft_type: str,
        payload: dict[str, Any],
        evidence_input: dict[str, Any] | None,
        current_message: str,
        trusted_resolution_sources: dict[str, TrustedResolutionSource],
        authorization: EffectiveAuthorization,
        auto_execution_attempted: bool,
        has_continuation: bool,
        is_composite: bool,
        has_external_side_effect: bool,
        registered_revert_adapters: frozenset[str],
    ) -> tuple[IntentEvidenceValidation, AutoExecutionDecision]:
        """Resolve server policy metadata before validating its evidence requirements."""
        policy = self.resolve_policy(draft_type=draft_type, payload=payload)
        requirements = ()
        if policy is not None:
            requirements = policy.evidence_requirements(
                db=db,
                family_id=family_id,
                actor_user_id=actor_user_id,
                payload=payload,
            )
        evidence = validate_intent_evidence(
            evidence=evidence_input,
            current_message=current_message,
            family_id=family_id,
            requirements=requirements,
            trusted_sources=trusted_resolution_sources,
        )
        context = AutoExecutionPolicyContext(
            db=db,
            family_id=family_id,
            actor_user_id=actor_user_id,
            draft_type=draft_type,
            payload=payload,
            evidence=evidence,
            authorization=authorization,
            auto_execution_attempted=auto_execution_attempted,
            has_continuation=has_continuation,
            is_composite=is_composite,
            has_external_side_effect=has_external_side_effect,
            registered_revert_adapters=registered_revert_adapters,
        )
        return evidence, self.evaluate(context)


auto_execution_policy_registry = AutoExecutionPolicyRegistry(build_action_policies())


def _manual_no_change_decision(
    *,
    policy_key: str | None,
    policy_version: str | None,
    authorization: EffectiveAuthorization,
    reason_code: str,
) -> AutoExecutionDecision:
    return AutoExecutionDecision(
        route="manual_confirmation",
        policy_key=policy_key,
        policy_version=policy_version,
        reason_codes=(reason_code,),
        authorization_source=authorization.source,
        authorization_snapshot=dict(authorization.snapshot),
    )
