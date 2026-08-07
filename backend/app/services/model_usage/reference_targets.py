from __future__ import annotations

from types import MappingProxyType


REFERENCE_LATENCY_TARGETS_MS = MappingProxyType(
    {
        "reserveP95Ms": 150,
        "settleP95Ms": 150,
        "currentOverviewP95Ms": 300,
        "currentBreakdownP95Ms": 1000,
        "historicalRollupP95Ms": 500,
    }
)

REFERENCE_QUERY_COUNT_TARGETS = MappingProxyType(
    {
        "currentAggregateQueryCount": 8,
        "currentBreakdownQueryCount": 6,
        "historicalRollupQueryCount": 3,
    }
)
