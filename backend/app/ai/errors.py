from __future__ import annotations


class AIConflictError(ValueError):
    """The requested AI state transition conflicts with persisted state."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        recovery_hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.recovery_hint = recovery_hint


class AIExecutionCancelled(RuntimeError):
    """The current AI run was cancelled and should stop cooperatively."""


class AutoExecutionBlockRequired(RuntimeError):
    """An uncertain policy-auto write must be fenced before the run can close."""

    def __init__(
        self,
        *,
        error_code: str,
        message: str,
        recovery_hint: str,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.recovery_hint = recovery_hint


class AIRuntimeFailurePersistenceError(RuntimeError):
    """The runtime could not durably close a failed Run."""

    code = "ai_runtime_failure_persistence_failed"


class HumanInputRequired(Exception):
    """The current AI run needs a user response before it can continue."""

    def __init__(self, request: dict) -> None:
        super().__init__("human input required")
        self.request = request


class ApprovalRequired(Exception):
    """The current AI run produced a draft and must wait for approval."""


class ToolBudgetHardStop(Exception):
    """The model continued calling tools after the run tool budget was exhausted."""

    def __init__(self, output: dict) -> None:
        super().__init__("tool budget hard stop")
        self.output = output


class ToolExecutionError(ValueError):
    """A Tool handler failure with an optional stable machine-readable code."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code
