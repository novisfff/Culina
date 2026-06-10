from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app.ai.planning.schemas import PlannerRequest, PlannerResult
from app.ai.runtime.provider import BaseChatProvider
from app.ai.skills.registry import SkillRegistry


PLANNER_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "skills": {
            "type": "array",
            "minItems": 0,
            "maxItems": 4,
            "uniqueItems": True,
            "items": {"type": "string"},
        }
    },
    "required": ["skills"],
}


class _PlannerSelection(BaseModel):
    skills: list[str] = Field(min_length=0, max_length=4)


class WorkspacePlanner:
    """Uses the model only to choose an ordered list of skills."""

    def __init__(self, *, provider: BaseChatProvider, skill_registry: SkillRegistry) -> None:
        self.provider = provider
        self.skill_registry = skill_registry

    def plan(self, request: PlannerRequest) -> PlannerResult:
        error = ""
        raw_response: str | None = None
        structured_mode: str | None = None
        for attempt in range(1, 3):
            result = self.provider.generate(
                system=self._system_prompt(),
                user=self._user_prompt(request, previous_error=error),
                response_schema=PLANNER_JSON_SCHEMA,
            )
            raw_response = result.text
            structured_mode = result.structured_mode
            if not result.text:
                error = result.error or "planner returned an empty response"
                continue
            try:
                selection = _PlannerSelection.model_validate(self._decode_response(result.text))
                self._validate_skills(selection.skills)
                return PlannerResult(
                    skills=selection.skills,
                    raw_response=result.text,
                    attempts=attempt,
                    structured_mode=structured_mode,
                )
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                error = self._diagnostic_message(exc)
        return PlannerResult(
            skills=[],
            raw_response=raw_response,
            attempts=2,
            error="AI 规划结果格式不正确，请重试。",
            diagnostic=error or "planner failed",
            structured_mode=structured_mode,
        )

    def _system_prompt(self) -> str:
        return (
            "你是 Culina AI 工作台的 Planner。"
            "你只负责根据完整对话选择接下来要执行的零个、一个或多个 Skill，并按执行顺序输出。"
            "不要判断 create、modify、derive，不要抽取参数，不要选择草稿，不要回答用户问题。"
            '普通聊天、解释、闲聊、能力介绍、无需工具或草稿的回答，必须返回 {"skills":[]}。'
            "“今天吃什么”“今晚吃什么”“推荐一餐”等即时餐食推荐属于 meal_plan Skill。"
            "需要业务能力时选择一个或多个已提供 Skill。"
            "只输出符合 JSON Schema 的裸 JSON 对象，禁止 Markdown 代码块、解释文字和额外字段。"
        )

    def _user_prompt(self, request: PlannerRequest, *, previous_error: str) -> str:
        payload: dict[str, Any] = {
            "conversation": request.conversation,
            "availableSkills": request.available_skills,
        }
        if previous_error:
            payload["previousValidationError"] = previous_error[:500]
            payload["instruction"] = '上一次输出无效。请只返回类似 {"skills":["meal_plan"]} 或 {"skills":[]} 的裸 JSON。'
        return json.dumps(payload, ensure_ascii=False, default=str)

    def _decode_response(self, text: str) -> dict[str, Any]:
        stripped = text.strip().lstrip("\ufeff")
        if stripped.startswith("```"):
            lines = stripped.splitlines()
            if len(lines) < 3 or lines[-1].strip() != "```":
                raise ValueError("incomplete JSON code fence")
            opening = lines[0].strip().lower()
            if opening not in {"```", "```json"}:
                raise ValueError("unsupported code fence language")
            stripped = "\n".join(lines[1:-1]).strip()
        value = json.loads(stripped)
        if not isinstance(value, dict):
            raise ValueError("planner response must be a JSON object")
        return value

    def _diagnostic_message(self, exc: Exception) -> str:
        if isinstance(exc, json.JSONDecodeError):
            return f"invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}"
        if isinstance(exc, ValidationError):
            errors = exc.errors(include_url=False, include_input=False)
            return json.dumps(errors, ensure_ascii=False, default=str)[:1000]
        return str(exc)[:1000]

    def _validate_skills(self, skills: list[str]) -> None:
        if len(skills) != len(set(skills)):
            raise ValueError("skills must not contain duplicates")
        allowed = self.skill_registry.keys()
        invalid = [skill for skill in skills if skill not in allowed]
        if invalid:
            raise ValueError(f"unknown skills: {', '.join(invalid)}")
