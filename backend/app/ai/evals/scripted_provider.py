from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.ai.errors import ApprovalRequired, HumanInputRequired, ToolBudgetHardStop
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult, ProviderUserContent


class ScriptedEvalProvider(BaseChatProvider):
    """Deterministic provider used only by evaluation tests."""

    model_name = "scripted-eval"

    def __init__(
        self,
        script: list[dict[str, Any]],
        *,
        argument_resolver: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        self._script = [dict(entry) for entry in script]
        self._used = 0
        self._provider_rounds = 0
        self.argument_resolver = argument_resolver
        self.last_error: Exception | None = None
        self.tool_outputs: dict[str, list[dict[str, Any]]] = {}

    def generate(self, *, system: str, user: ProviderUserContent, **_: Any) -> ChatProviderResult:
        del system, user
        raise AssertionError("scripted evaluations must use the tool-capable provider path")

    def generate_with_tools(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools,
        tool_handler,
        message_handler=None,
        tool_preview_handler=None,
        max_rounds: int = 8,
        trace_recorder=None,
    ) -> ChatProviderResult:
        del system, user, tool_preview_handler, max_rounds, trace_recorder
        self._provider_rounds += 1
        next_entry = self._script[self._used] if self._used < len(self._script) else None
        if self._provider_rounds == 1:
            if isinstance(next_entry, dict) and next_entry.get("resume") is True:
                raise AssertionError("scripted evaluation cannot start at a resume boundary")
        else:
            if not isinstance(next_entry, dict) or next_entry.get("resume") is not True:
                raise AssertionError("unexpected extra provider round in scripted evaluation")
            self._used += 1
        calls: list[dict[str, Any]] = []
        text = ""
        while self._used < len(self._script):
            entry = self._script[self._used]
            self._used += 1
            if "inject" in entry:
                skill_key = str(entry["inject"])
                output = tool_handler(
                    "skill.inject",
                    {"skills": [skill_key], "reason": "deterministic evaluation"},
                    None,
                    f"{self.model_name}:inject:{self._used}",
                )
                calls.append({"name": "skill.inject", "args": {"skills": [skill_key]}, "output": output})
                continue
            if "assistantText" in entry:
                chunk = str(entry["assistantText"])
                text += chunk
                if message_handler is not None:
                    message_handler(chunk)
                continue
            call = entry.get("toolCall")
            if isinstance(call, dict):
                name = str(call.get("name") or "")
                arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                available = {definition.name for definition in tools()}
                if name not in available:
                    raise AssertionError(f"scripted tool is outside the current execution record: {name}")
                output = tool_handler(name, arguments, None, str(call.get("id") or f"{self.model_name}:{self._used}"))
                calls.append({"name": name, "args": arguments, "output": output})
                self.tool_outputs.setdefault(name, []).append(output)
                continue
            probe = entry.get("toolProbe")
            if isinstance(probe, dict):
                name = str(probe.get("name") or "")
                available = {definition.name for definition in tools()}
                if name not in available:
                    raise AssertionError(f"scripted tool is outside the current execution record: {name}")
                if self.argument_resolver is None:
                    raise AssertionError(f"scripted tool has no argument resolver: {name}")
                if name == "meal_plan.propose_from_inventory":
                    for prerequisite_name in ("food.search", "recipe.search"):
                        prerequisite_args = {"query": "__eval_no_match__", "limit": 24}
                        prerequisite_output = tool_handler(
                            prerequisite_name,
                            prerequisite_args,
                            None,
                            f"{self.model_name}:prerequisite:{prerequisite_name}",
                        )
                        calls.append({"name": prerequisite_name, "args": prerequisite_args, "output": prerequisite_output})
                arguments = self.argument_resolver(name)
                try:
                    output = tool_handler(
                        name,
                        arguments,
                        None,
                        str(probe.get("id") or f"{self.model_name}:{self._used}"),
                    )
                except (ApprovalRequired, HumanInputRequired, ToolBudgetHardStop):
                    raise
                except Exception as exc:
                    self.last_error = exc
                    raise
                calls.append({"name": name, "args": arguments, "output": output})
                self.tool_outputs.setdefault(name, []).append(output)
                continue
            if "providerFailure" in entry:
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=self.model_name,
                    error=str(entry["providerFailure"]),
                    tool_calls=calls,
                )
            raise AssertionError(f"unsupported scripted eval entry: {entry}")
        return ChatProviderResult(
            text=text or "评估场景已完成。",
            status="completed",
            model=self.model_name,
            tool_calls=calls,
        )

    def assert_consumed(self) -> None:
        if self._used != len(self._script):
            raise AssertionError(f"script has {len(self._script) - self._used} unused entries")
