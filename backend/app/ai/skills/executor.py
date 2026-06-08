from __future__ import annotations

from app.ai.planning.schemas import PlannerResult
from app.ai.skills.base import SkillContext, SkillExecutionResult, SkillResult
from app.ai.skills.registry import SkillRegistry


class SkillExecutor:
    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    def run(self, plan: PlannerResult, context: SkillContext) -> SkillExecutionResult:
        if plan.failed:
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
        combined_text: list[str] = []
        cards: list[dict] = []
        drafts: list[dict] = []
        events: list[dict] = []
        context_summary: dict = {"skillExecutions": []}
        state_patch: dict = {}
        status = "completed"
        model = getattr(context.provider, "model_name", "") or "model"
        error: str | None = None
        root_tool_executor = context.tool_executor

        for skill_key in plan.skills:
            skill = self.registry.get(skill_key)
            context.previous_results = results
            allowed_side_effects = {"read"}
            if skill.manifest.approval_policy == "draft_then_confirm":
                allowed_side_effects.add("draft")
            context.tool_executor = root_tool_executor.scoped(
                allowed_tools=set(skill.manifest.tools),
                allowed_side_effects=allowed_side_effects,
            )
            try:
                result = skill.run(context)
            except Exception as exc:
                result = SkillResult(
                    text=f"{skill.manifest.name}执行失败。",
                    status="failed",
                    error=f"{skill.manifest.name}执行失败，请重试。",
                    diagnostic=str(exc),
                    model=model,
                )
            results.append(result)
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
            events.extend(result.events)
            context_summary.update(result.context_summary)
            state_patch.update(result.state_patch)
            model = result.model or model
            if result.status == "failed" or result.requires_clarification:
                status = result.status
                error = result.error
                break
        context.tool_executor = root_tool_executor

        return SkillExecutionResult(
            text="\n\n".join(combined_text).strip() or "我还需要更多信息才能继续。",
            cards=cards,
            drafts=drafts,
            events=events,
            tool_calls=root_tool_executor.records(),
            context_summary=context_summary,
            state_patch=state_patch,
            status=status,
            model=model,
            error=error,
        )
