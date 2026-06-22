class AIConflictError(ValueError):
    """The requested AI state transition conflicts with persisted state."""


class AIExecutionCancelled(RuntimeError):
    """The current AI run was cancelled and should stop cooperatively."""


class HumanInputRequired(Exception):
    """The current AI run needs a user response before it can continue."""

    def __init__(self, request: dict) -> None:
        super().__init__("human input required")
        self.request = request
