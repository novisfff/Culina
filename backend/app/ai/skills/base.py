from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.ai.runtime.provider import BaseChatProvider
from app.ai.skills.scripts import SkillScriptRuntime
from app.ai.tools.executor import ToolExecutor
from app.core.utils import create_id, utcnow


@dataclass(slots=True)
class SkillManifest:
    key: str
    name: str
    description: str
    slug: str = ""
    version: str = "1.0.0"
    category: str = "general"
    runner: str = "markdown"
    risk_level: str = "low"
    examples: list[str] = field(default_factory=list)
    context_policy: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    forbidden_tools: list[str] = field(default_factory=list)
    requires_confirmation: list[str] = field(default_factory=list)
    workflow_files: list[str] = field(default_factory=list)
    hitl_files: list[str] = field(default_factory=list)
    example_files: list[str] = field(default_factory=list)
    script_files: list[str] = field(default_factory=list)
    output_types: list[str] = field(default_factory=list)
    draft_types: list[str] = field(default_factory=list)
    approval_policy: str = "none"
    can_continue_from: list[str] = field(default_factory=list)
    intent: str = ""
    agent_key: str = ""

    def to_planner_record(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "slug": self.slug or self.key.replace("_", "-"),
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
    current_run_artifacts: list[dict[str, Any]] = field(default_factory=list)
    stream_writer: Callable[[dict[str, Any]], None] | None = None

    def emit_progress(
        self,
        event_type: str,
        internal_code: str,
        user_message: str,
        status: str = "running",
    ) -> None:
        if self.stream_writer is None:
            return
        self.stream_writer(
            {
                "event": "progress",
                "data": {
                    "id": create_id("ai_run_event"),
                    "run_id": self.run_id,
                    "type": event_type,
                    "internal_code": internal_code,
                    "user_message": user_message,
                    "status": status,
                    "created_at": utcnow(),
                },
            }
        )


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
    scripts: SkillScriptRuntime

    def __init__(self, manifest: SkillManifest, skill_dir: Path | None = None) -> None:
        self.manifest = manifest
        self.skill_dir = skill_dir
        self.scripts = SkillScriptRuntime(skill_dir, manifest.script_files)

    def run(self, context: SkillContext) -> SkillResult:  # pragma: no cover - interface
        raise NotImplementedError
