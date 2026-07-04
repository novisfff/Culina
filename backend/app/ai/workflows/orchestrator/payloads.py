from __future__ import annotations

import json
from typing import Any

from app.ai.runtime.provider import ProviderUserInput
from app.ai.skills.base import SkillContext
from app.ai.skills.shared import conversation_artifacts
from app.ai.workflows.compact_context import compact_artifacts, compact_conversation, compact_previous_results
from app.ai.workflows.orchestrator.profiles import (
    DEFAULT_ORCHESTRATOR_PROFILE,
    OrchestratorBudgetConfig,
    OrchestratorCapabilityPolicy,
    profile_state_value,
)
from app.ai.workflows.orchestrator.prompts import DEFAULT_ORCHESTRATOR_PROMPT, build_orchestrator_system_prompt
from app.ai.workflows.orchestrator.tools import SkillInjectionManager


class OrchestratorPromptPayloadBuilder:
    def __init__(self, injection_manager: SkillInjectionManager) -> None:
        self.injection_manager = injection_manager

    def profile_state(self, context: SkillContext) -> dict[str, Any]:
        return context.orchestrator_profile or DEFAULT_ORCHESTRATOR_PROFILE.to_state()

    def capability_policy(self, profile_state: dict[str, Any]) -> OrchestratorCapabilityPolicy:
        value = profile_state_value(profile_state, "capabilityPolicy", "capability_policy")
        return OrchestratorCapabilityPolicy.from_state(value if isinstance(value, dict) else None)

    def budget_config(
        self,
        profile_state: dict[str, Any],
        capability_policy: OrchestratorCapabilityPolicy,
    ) -> OrchestratorBudgetConfig:
        value = profile_state_value(profile_state, "budgetConfig", "budget_config")
        return OrchestratorBudgetConfig.from_state(value if isinstance(value, dict) else None).for_capability_policy(capability_policy)

    def system_prompt(self, context: SkillContext, active_skill_keys: list[str]) -> str:
        bundles = self.injection_manager.bundles_for(active_skill_keys)
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        profile_state = self.profile_state(context)
        capability_policy = self.capability_policy(profile_state)
        include_draft_contract = capability_policy.exposes_draft_contract(
            has_draft_capability=bool(allowed_draft_types)
        )
        return build_orchestrator_system_prompt(
            config=DEFAULT_ORCHESTRATOR_PROMPT,
            context=context,
            catalog_records=self.injection_manager.catalog_records(capability_policy) if capability_policy.exposes_catalog_records() else [],
            injected_skill_records=[bundle.manifest_record for bundle in bundles],
            injected_skill_instruction_sections=[
                f"# {bundle.display_name} ({bundle.key})\n\n{bundle.instructions}"
                for bundle in bundles
                if bundle.instructions
            ],
            allowed_draft_types=allowed_draft_types,
            profile_state=profile_state,
            include_catalog_records=capability_policy.exposes_catalog_records(),
            include_dynamic_injection_contract=capability_policy.exposes_dynamic_injection_contract(),
            include_draft_contract=include_draft_contract,
            include_allowed_draft_types=include_draft_contract,
            include_injected_skill_records=capability_policy.exposes_dynamic_injection_contract(),
            artifact_context_policy=capability_policy.artifact_context,
        )

    def user_payload(
        self,
        context: SkillContext,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        capability_policy: OrchestratorCapabilityPolicy | None = None,
    ) -> dict[str, Any]:
        capability_policy = capability_policy or self.capability_policy(self.profile_state(context))
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        include_draft_artifacts = capability_policy.artifact_context == "all"
        include_artifacts = capability_policy.artifact_context != "hidden"
        payload = {
            "currentMessage": context.current_message,
            "currentAttachments": context.current_message_attachments,
            "quickTask": context.quick_task,
            "subject": context.subject,
            "conversation": compact_conversation(
                context.conversation,
                include_draft_artifacts=include_draft_artifacts,
            ),
            "artifacts": compact_artifacts(
                conversation_artifacts(context),
                include_draft_artifacts=include_draft_artifacts,
            ) if include_artifacts else [],
            "previousResults": compact_previous_results(
                context.previous_results,
                include_draft_artifacts=include_draft_artifacts,
            ) if include_artifacts else [],
            "currentRunArtifacts": compact_artifacts(
                context.current_run_artifacts,
                include_draft_artifacts=include_draft_artifacts,
            ) if include_artifacts else [],
            "injectedSkills": active_skill_keys,
            "injectionHistory": injection_history,
        }
        if capability_policy.exposes_draft_contract(has_draft_capability=bool(allowed_draft_types)):
            payload["allowedDraftTypes"] = allowed_draft_types
        return payload

    def provider_user_input(
        self,
        context: SkillContext,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        capability_policy: OrchestratorCapabilityPolicy | None = None,
    ) -> str | ProviderUserInput:
        payload = self.user_payload(
            context,
            active_skill_keys,
            injection_history,
            capability_policy,
        )
        prefix_messages = _stable_prefix_messages(context.subject)
        if prefix_messages:
            payload["subject"] = _runtime_subject(context.subject)
        text = json.dumps(payload, ensure_ascii=False, default=str)
        if not context.current_message_images and not prefix_messages:
            return text
        return ProviderUserInput(
            text=text,
            images=context.current_message_images,
            prefix_messages=prefix_messages,
        )


def _stable_prefix_messages(subject: dict[str, Any]) -> list[str]:
    extra = subject.get("extra") if isinstance(subject, dict) and isinstance(subject.get("extra"), dict) else {}
    stable_context = extra.get("stableContext") if isinstance(extra, dict) else None
    if not isinstance(stable_context, dict):
        return []
    return [
        json.dumps(
            {
                "type": "stableSubject",
                "subject": stable_context,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    ]


def _runtime_subject(subject: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(subject, dict):
        return {}
    extra = subject.get("extra") if isinstance(subject.get("extra"), dict) else {}
    runtime_context = extra.get("runtimeContext") if isinstance(extra, dict) else None
    runtime_subject = {
        key: value
        for key, value in subject.items()
        if key != "extra"
    }
    if isinstance(runtime_context, dict):
        runtime_subject["runtimeContext"] = runtime_context
        return runtime_subject
    runtime_extra = {
        key: value
        for key, value in extra.items()
        if key != "stableContext"
    }
    if runtime_extra:
        runtime_subject["extra"] = runtime_extra
    return runtime_subject
