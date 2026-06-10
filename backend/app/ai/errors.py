class AIConflictError(ValueError):
    """The requested AI state transition conflicts with persisted state."""


class AIExecutionCancelled(RuntimeError):
    """The current AI run was cancelled and should stop cooperatively."""
