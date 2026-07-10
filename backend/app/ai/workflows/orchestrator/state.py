from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.ai.skills.scripts import SkillScriptExecutor
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.profiles import OrchestratorBudgetConfig, OrchestratorCapabilityPolicy


@dataclass(slots=True)
class OrchestratorRunState:
    active_skill_keys: list[str]
    profile_key: str
    response_style: str
    capability_policy: OrchestratorCapabilityPolicy
    base_budget_config: OrchestratorBudgetConfig
    budget_config: OrchestratorBudgetConfig
    injection_history: list[dict[str, Any]]
    trace_round_index: int
    message_id: str
    part_id: str
    historical_tool_signatures: list[str]
    requires_terminal_output: bool = False
    terminal_text_allowed: bool = True
    streamed_text: list[str] = field(default_factory=list)
    draft_outputs: list[dict[str, Any]] = field(default_factory=list)
    result_card_outputs: list[dict[str, Any]] = field(default_factory=list)
    tool_outputs_this_call: list[dict[str, Any]] = field(default_factory=list)
    pending_followups: list[dict[str, Any]] = field(default_factory=list)
    terminal_tool_outputs: list[dict[str, Any]] = field(default_factory=list)
    published_drafts_by_key: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    draft_input_keys_this_call: set[tuple[str, str]] = field(default_factory=set)
    read_outputs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    tool_signatures_this_call: list[str] = field(default_factory=list)
    tool_budget_exhausted: bool = False
    tool_budget_exhausted_attempts: int = 0
    tool_budget_hard_stopped: bool = False
    tool_budget_last_output: dict[str, Any] | None = None
    draft_created_this_call: bool = False
    human_input_requested_this_call: bool = False
    current_scoped_executor: Any | None = None
    current_script_executors: dict[str, SkillScriptExecutor] = field(default_factory=dict)
    current_tool_names: set[str] = field(default_factory=set)
    current_tool_definitions: dict[str, ToolDefinition] = field(default_factory=dict)
    preview_event_ids_by_key: dict[str, str] = field(default_factory=dict)
    quality_summary: dict[str, Any] = field(default_factory=dict)
