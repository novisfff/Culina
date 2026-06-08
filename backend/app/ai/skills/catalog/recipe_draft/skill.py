from __future__ import annotations

from pathlib import Path

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import RECIPE_DRAFT_JSON_SCHEMA, build_recipe_draft_messages, normalize_recipe_draft
from app.ai.runtime.schemas import AgentRunRequest
from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.shared import legacy_subject
from app.core.enums import AiMode


def _infer_recipe_title(prompt: str) -> str:
    text = prompt.strip()
    for prefix in ["帮我生成一份", "帮我生成", "生成一份", "生成", "做一份", "做"]:
        if text.startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    for suffix in ["的菜谱", "菜谱", "，", ",", "。"]:
        if suffix in text:
            text = text.split(suffix, 1)[0].strip()
    return text[:40]


class RecipeDraftSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        provider = context.provider
        subject = dict(legacy_subject(context))
        if "title" not in subject:
            subject["title"] = _infer_recipe_title(context.current_message)
        subject.setdefault("servings", 2)
        agent_request = AgentRunRequest(
            family_id=context.family_id,
            user_id=context.user_id,
            feature_key="ai_workspace_recipe_draft",
            prompt=context.current_message,
            mode=AiMode.RECIPE_DRAFT,
            subject=subject,
            response_format="recipe_draft",
            persist_conversation=False,
        )
        agent_context = load_agent_context(context.db, family_id=context.family_id, mode=AiMode.RECIPE_DRAFT, subject=subject, include_inventory=False, include_meal_logs=False)
        if provider is None:
            return SkillResult(text="现在还不能生成菜谱草稿：AI provider 未配置。", status="failed", model="rules", error="AI provider 未配置", context_summary=agent_context.to_record())
        system, user = build_recipe_draft_messages(agent_context, agent_request)
        result = provider.generate(system=system, user=user, response_schema=RECIPE_DRAFT_JSON_SCHEMA)
        if not result.text:
            return SkillResult(text="这次没有生成可用的菜谱草稿。", status="failed", model=result.model, error=result.error or "provider returned no structured recipe draft", context_summary=agent_context.to_record())
        draft = normalize_recipe_draft(result.text, agent_context, agent_request)
        if draft is None:
            return SkillResult(text="模型返回的菜谱结构不完整，我没有把它保存成草稿。", status="failed", model=result.model, error="invalid recipe draft json", context_summary=agent_context.to_record())
        context.tool_executor.call("recipe.create_draft", {"draft": draft})
        title = draft.get("title", "菜谱草稿")
        ingredient_count = len(draft.get("ingredient_items", []))
        step_count = len(draft.get("steps", []))
        return SkillResult(text=f"我生成了《{title}》的菜谱草稿，包含 {ingredient_count} 个食材项和 {step_count} 个步骤。你可以先编辑，再确认创建菜谱。", drafts=[{"draft_type": "recipe", "payload": draft, "schema_version": "recipe.v1"}], context_summary=agent_context.to_record(), status="completed", model=result.model)


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return RecipeDraftSkill(manifest, skill_dir)
