from __future__ import annotations

import logging

from app.ai.planning.schemas import PlannerResult
from app.ai.skills.base import BaseSkill
from app.ai.skills.base import SkillContext, SkillExecutionResult, SkillResult
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.shared import result_artifacts
from app.ai.errors import AIExecutionCancelled

logger = logging.getLogger(__name__)


VALID_APPROVAL_POLICIES = {"none", "draft_then_confirm"}
VALID_RESULT_STATUSES = {"completed", "failed", "fallback"}


class SkillExecutor:
    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    def run_step(self, skill_key: str, context: SkillContext) -> SkillResult:
        skill = self.registry.get(skill_key)
        root_tool_executor = context.tool_executor
        allowed_side_effects = {"read"}
        if skill.manifest.approval_policy == "draft_then_confirm":
            allowed_side_effects.add("draft")
        logger.info(
            "AI skill started skill=%s runner=%s run_id=%s conversation_id=%s family_id=%s approval_policy=%s allowed_side_effects=%s tool_count=%s",
            skill_key,
            skill.manifest.runner,
            context.run_id,
            context.conversation_id,
            context.family_id,
            skill.manifest.approval_policy,
            sorted(allowed_side_effects),
            len(skill.manifest.tools),
        )
        context.emit_progress("skill", f"{skill_key}.start", f"调用「{skill.manifest.name}」技能")
        try:
            self._validate_manifest_contract(skill, context)
            context.tool_executor = root_tool_executor.scoped(
                allowed_tools=set(skill.manifest.tools),
                allowed_side_effects=allowed_side_effects,
            )
            result = skill.run(context)
            self._validate_result_contract(skill, result)
        except AIExecutionCancelled:
            raise
        except Exception as exc:
            logger.warning(
                "AI skill failed skill=%s runner=%s run_id=%s conversation_id=%s family_id=%s error=%s",
                skill_key,
                skill.manifest.runner,
                context.run_id,
                context.conversation_id,
                context.family_id,
                exc,
                exc_info=True,
            )
            result = SkillResult(
                text=f"{skill.manifest.name}执行失败。",
                status="failed",
                error=f"{skill.manifest.name}执行失败，请重试。",
                diagnostic=str(exc),
                model=getattr(context.provider, "model_name", ""),
            )
        finally:
            context.tool_executor = root_tool_executor
        result.tool_calls = root_tool_executor.records()
        if result.status == "failed":
            logger.warning(
                "AI skill returned failed status skill=%s run_id=%s conversation_id=%s family_id=%s error=%s diagnostic=%s tool_calls=%s",
                skill_key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                result.error,
                result.diagnostic,
                len(result.tool_calls),
            )
            context.emit_progress("skill", f"{skill_key}.failed", f"{skill.manifest.name}执行失败", "failed")
        else:
            logger.info(
                "AI skill completed skill=%s run_id=%s conversation_id=%s family_id=%s status=%s drafts=%s cards=%s events=%s tool_calls=%s",
                skill_key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                result.status,
                len(result.drafts),
                len(result.cards),
                len(result.events),
                len(result.tool_calls),
            )
            context.emit_progress("skill", f"{skill_key}.completed", f"{skill.manifest.name}执行完成", "completed")
        return result

    def _validate_manifest_contract(self, skill: BaseSkill, context: SkillContext) -> None:
        manifest = skill.manifest
        if manifest.approval_policy not in VALID_APPROVAL_POLICIES:
            raise ValueError(f"Skill {manifest.key} declares invalid approval_policy: {manifest.approval_policy}")

        definitions = [context.tool_executor.registry.get(name) for name in manifest.tools]
        if any(definition.side_effect == "write" for definition in definitions):
            raise ValueError(f"Skill {manifest.key} must not expose write tools")

        if manifest.approval_policy == "none":
            if any(definition.side_effect != "read" for definition in definitions):
                raise ValueError(f"Skill {manifest.key} exposes non-read tools without approval")
            if manifest.draft_types:
                raise ValueError(f"Skill {manifest.key} declares draft types without approval")
            return

        if not manifest.draft_types:
            raise ValueError(f"Skill {manifest.key} requires approval but declares no draft types")
        draft_tools = [definition for definition in definitions if definition.side_effect == "draft"]
        if not draft_tools:
            raise ValueError(f"Skill {manifest.key} requires approval but exposes no draft tools")
        if any(not definition.requires_confirmation for definition in draft_tools):
            raise ValueError(f"Skill {manifest.key} exposes draft tools that do not require confirmation")

    def _validate_result_contract(self, skill: BaseSkill, result: SkillResult) -> None:
        manifest = skill.manifest
        if result.status not in VALID_RESULT_STATUSES:
            raise ValueError(f"Skill {manifest.key} returned invalid status: {result.status}")
        if not isinstance(result.text, str):
            raise ValueError(f"Skill {manifest.key} returned non-text response")
        if not isinstance(result.context_summary, dict):
            raise ValueError(f"Skill {manifest.key} returned invalid context_summary")
        if not isinstance(result.state_patch, dict):
            raise ValueError(f"Skill {manifest.key} returned invalid state_patch")

        allowed_card_types = set(manifest.output_types) | {"error_recovery"}
        for card in result.cards:
            if not isinstance(card, dict):
                raise ValueError(f"Skill {manifest.key} returned an invalid card payload")
            card_type = str(card.get("type") or "")
            if not card_type:
                raise ValueError(f"Skill {manifest.key} returned a card without type")
            if allowed_card_types and card_type not in allowed_card_types:
                raise ValueError(f"Skill {manifest.key} returned undeclared card type: {card_type}")

        for event in result.events:
            if not isinstance(event, dict):
                raise ValueError(f"Skill {manifest.key} returned an invalid event payload")

        if not result.drafts:
            return
        if manifest.approval_policy != "draft_then_confirm":
            raise ValueError(f"Skill {manifest.key} returned drafts without draft approval policy")
        allowed_draft_types = set(manifest.draft_types)
        for draft in result.drafts:
            if not isinstance(draft, dict):
                raise ValueError(f"Skill {manifest.key} returned an invalid draft payload")
            draft_type = str(draft.get("draft_type") or "")
            if draft_type not in allowed_draft_types:
                raise ValueError(f"Skill {manifest.key} returned undeclared draft type: {draft_type}")
            if not isinstance(draft.get("payload"), dict):
                raise ValueError(f"Skill {manifest.key} returned draft without object payload")
            schema_version = draft.get("schema_version")
            if schema_version is not None and not isinstance(schema_version, str):
                raise ValueError(f"Skill {manifest.key} returned draft with invalid schema_version")

    def run(self, plan: PlannerResult, context: SkillContext) -> SkillExecutionResult:
        if plan.failed:
            logger.warning(
                "AI skill execution skipped because planner failed run_id=%s conversation_id=%s family_id=%s error=%s diagnostic=%s",
                context.run_id,
                context.conversation_id,
                context.family_id,
                plan.error,
                plan.diagnostic,
            )
            return SkillExecutionResult(
                text="AI 规划暂时失败，请重试。",
                cards=[],
                drafts=[],
                events=[],
                tool_calls=[],
                context_summary={
                    "plannerError": plan.error,
                    "plannerDiagnostic": plan.diagnostic,
                    "plannerAttempts": plan.attempts,
                    "plannerStructuredMode": plan.structured_mode,
                },
                state_patch={},
                status="failed",
                model=getattr(context.provider, "model_name", ""),
                error=plan.error,
            )

        results: list[SkillResult] = []
        run_artifacts: list[dict] = []
        combined_text: list[str] = []
        cards: list[dict] = []
        drafts: list[dict] = []
        events: list[dict] = []
        context_summary: dict = {"skillExecutions": []}
        state_patch: dict = {}
        status = "completed"
        model = getattr(context.provider, "model_name", "") or "model"
        error: str | None = None
        logger.info(
            "AI skill execution started run_id=%s conversation_id=%s family_id=%s skills=%s",
            context.run_id,
            context.conversation_id,
            context.family_id,
            plan.skills,
        )
        for skill_key in plan.skills:
            context.previous_results = results
            context.current_run_artifacts = run_artifacts
            result = self.run_step(skill_key, context)
            results.append(result)
            run_artifacts.extend(result_artifacts(skill_key, result))
            context_summary["skillExecutions"].append(
                {
                    "skillKey": skill_key,
                    "operation": result.operation,
                    "sourceArtifactId": result.source_artifact_id,
                    "status": result.status,
                    "diagnostic": result.diagnostic,
                }
            )
            if result.text:
                combined_text.append(result.text)
            cards.extend(result.cards)
            drafts.extend(result.drafts)
            context_summary.update(result.context_summary)
            state_patch.update(result.state_patch)
            model = result.model or model
            if result.status == "failed" or result.requires_clarification:
                status = result.status
                error = result.error
                break
        logger.info(
            "AI skill execution completed run_id=%s conversation_id=%s family_id=%s status=%s skills_run=%s drafts=%s cards=%s error=%s",
            context.run_id,
            context.conversation_id,
            context.family_id,
            status,
            len(results),
            len(drafts),
            len(cards),
            error,
        )
        return SkillExecutionResult(
            text="\n\n".join(combined_text).strip() or "我还需要更多信息才能继续。",
            cards=cards,
            drafts=drafts,
            events=events,
            tool_calls=context.tool_executor.records(),
            context_summary=context_summary,
            state_patch=state_patch,
            status=status,
            model=model,
            error=error,
        )
