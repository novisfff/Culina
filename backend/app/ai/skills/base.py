from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.ai.runtime.provider import BaseChatProvider
from app.ai.tools.executor import ToolExecutor


@dataclass(slots=True)
class SkillManifest:
    key: str
    name: str
    description: str
    examples: list[str]
    context_policy: list[str]
    tools: list[str]
    output_types: list[str]
    draft_types: list[str]
    approval_policy: str
    can_continue_from: list[str]
    intent: str
    agent_key: str

    def to_planner_record(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "examples": self.examples,
            "contextPolicy": self.context_policy,
            "outputs": self.output_types,
            "draftTypes": self.draft_types,
            "approvalPolicy": self.approval_policy,
            "canContinueFrom": self.can_continue_from,
        }


@dataclass(slots=True)
class SkillContext:
    db: Session
    family_id: str
    user_id: str
    conversation_id: str
    run_id: str
    conversation: list[dict[str, Any]]
    current_message: str
    tool_executor: ToolExecutor
    provider: BaseChatProvider | None = None
    previous_results: list["SkillResult"] = field(default_factory=list)


@dataclass(slots=True)
class SkillResult:
    text: str
    cards: list[dict[str, Any]] = field(default_factory=list)
    drafts: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    context_summary: dict[str, Any] = field(default_factory=dict)
    state_patch: dict[str, Any] = field(default_factory=dict)
    status: str = "completed"
    model: str = "rules"
    error: str | None = None
    diagnostic: str | None = None
    operation: str | None = None
    source_artifact_id: str | None = None
    requires_clarification: bool = False


@dataclass(slots=True)
class SkillExecutionResult:
    text: str
    cards: list[dict[str, Any]]
    drafts: list[dict[str, Any]]
    events: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    context_summary: dict[str, Any]
    state_patch: dict[str, Any]
    status: str
    model: str
    error: str | None = None


class BaseSkill:
    manifest: SkillManifest
    skill_dir: Path | None

    def __init__(self, manifest: SkillManifest, skill_dir: Path | None = None) -> None:
        self.manifest = manifest
        self.skill_dir = skill_dir

    def run(self, context: SkillContext) -> SkillResult:  # pragma: no cover - interface
        raise NotImplementedError
