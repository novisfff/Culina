from __future__ import annotations

from app.services.ai_revert.errors import ai_revert_error
from app.services.ai_revert.types import AIRevertAdapter


class AIRevertAdapterRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, AIRevertAdapter] = {}

    def register(self, adapter: AIRevertAdapter) -> None:
        if adapter.key in self._adapters:
            raise ValueError(f"duplicate AI revert adapter: {adapter.key}")
        self._adapters[adapter.key] = adapter

    def require(self, key: str) -> AIRevertAdapter:
        adapter = self._adapters.get(key)
        if adapter is None:
            raise ai_revert_error("operation_not_revertible")
        return adapter

    def supports(self, key: str) -> bool:
        return key in self._adapters

    @property
    def keys(self) -> frozenset[str]:
        return frozenset(self._adapters)


ai_revert_adapter_registry = AIRevertAdapterRegistry()
