from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.ai.runtime.provider import BaseChatProvider, ProviderImageInput
from app.ai.skills.contracts import SkillAttachmentPolicy, SkillHandoffPolicy, SkillRoutingPolicy
from app.ai.tools.executor import ToolExecutor
from app.core.utils import create_id, utcnow


@dataclass(slots=True)
class SkillCompletionPolicy:
    requires_terminal_output: bool = False
    terminal_text_allowed: bool = True
    terminal_tools: dict[str, str] = field(default_factory=dict)
    followup_required_tools: dict[str, str] = field(default_factory=dict)

    def to_catalog_record(self) -> dict[str, Any]:
        return {
            "requiresTerminalOutput": self.requires_terminal_output,
            "terminalTextAllowed": self.terminal_text_allowed,
            "terminalTools": self.terminal_tools,
            "followupRequiredTools": self.followup_required_tools,
        }


@dataclass(slots=True)
class SkillManifest:
    key: str
    name: str
    description: str
    slug: str = ""
    runner: str = "toolcall"
    examples: list[str] = field(default_factory=list)
    context_policy: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    script_files: list[str] = field(default_factory=list)
    output_types: list[str] = field(default_factory=list)
    draft_types: list[str] = field(default_factory=list)
    route_hints: list[str] = field(default_factory=list)
    tool_budget: dict[str, int] = field(default_factory=dict)
    completion_policy: SkillCompletionPolicy = field(default_factory=SkillCompletionPolicy)
    draft_contract: dict[str, dict[str, str]] = field(default_factory=dict)
    approval_policy: str = "none"
    intent: str = ""
    agent_key: str = ""
    contract_version: int = 2
    routing: SkillRoutingPolicy = field(default_factory=SkillRoutingPolicy)
    handoffs: dict[str, SkillHandoffPolicy] = field(default_factory=dict)
    attachment_policy: SkillAttachmentPolicy = field(default_factory=SkillAttachmentPolicy)

    def handoffs_record(self) -> dict[str, dict[str, str]]:
        return {reason: policy.to_record() for reason, policy in self.handoffs.items()}

    def to_routing_record(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "displayName": self.name,
            "description": self.description,
            "examples": self.examples,
            "contextPolicy": self.context_policy,
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

    def to_catalog_record(self) -> dict[str, Any]:
        return self.to_execution_record()


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
    subject: dict[str, Any] = field(default_factory=dict)
    orchestrator_profile: dict[str, Any] = field(default_factory=dict)
    current_message_attachments: list[dict[str, Any]] = field(default_factory=list)
    current_message_images: list[ProviderImageInput] = field(default_factory=list)
    quick_task: str | None = None
    provider: BaseChatProvider | None = None
    previous_results: list["SkillResult"] = field(default_factory=list)
    current_run_artifacts: list[dict[str, Any]] = field(default_factory=list)
    stream_writer: Callable[[dict[str, Any]], None] | None = None
    progressive_draft_publisher: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    cancel_check: Callable[[], bool] | None = None
    tracer: Any | None = None
    trace_parent_span_id: str | None = None
    trace_round_index: int | None = None

    def ensure_active(self) -> None:
        if self.cancel_check is not None and self.cancel_check():
            from app.ai.errors import AIExecutionCancelled

            raise AIExecutionCancelled("AI run was cancelled")

    def emit_progress(
        self,
        event_type: str,
        internal_code: str,
        user_message: str,
        status: str = "running",
        event_id: str | None = None,
    ) -> None:
        self.ensure_active()
        if self.stream_writer is None:
            return
        self.stream_writer(
            {
                "event": "progress",
                "data": {
                    "id": event_id or create_id("ai_run_event"),
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

class BaseSkill:
    manifest: SkillManifest
    skill_dir: Path | None

    def __init__(self, manifest: SkillManifest, skill_dir: Path | None = None) -> None:
        self.manifest = manifest
        self.skill_dir = skill_dir

    def run(self, context: SkillContext) -> SkillResult:  # pragma: no cover - interface
        raise NotImplementedError


class CatalogSkill(BaseSkill):
    def __init__(self, manifest: SkillManifest, skill_dir: Path | None = None, *, instructions: str = "") -> None:
        super().__init__(manifest, skill_dir)
        self.instructions = instructions
        if skill_dir is None:
            self.script_catalog = None
        else:
            from app.ai.skills.scripts import SkillScriptCatalog

            self.script_catalog = SkillScriptCatalog(skill_dir, manifest.script_files)

    def run(self, context: SkillContext) -> SkillResult:  # pragma: no cover - catalog-only skill
        del context
        raise RuntimeError("CatalogSkill is a context/tool package and is not executed directly")
