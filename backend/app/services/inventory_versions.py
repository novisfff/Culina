from __future__ import annotations

from typing import Any

from app.models.domain import Ingredient

STALE_VERSION_CODE = "stale_version"
STALE_INVENTORY_DETAIL = "库存批次已被其他成员更新，请刷新后重试"


class InventoryConflictError(ValueError):
    """Structured concurrency conflict for inventory-related writes."""

    def __init__(
        self,
        message: str = STALE_INVENTORY_DETAIL,
        *,
        code: str = STALE_VERSION_CODE,
        conflicts: list[dict[str, object]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.conflicts = list(conflicts or [])
        self.message = message


def require_expected_version(
    entity: object,
    expected: int,
    *,
    entity_type: str,
    entity_id: str,
) -> None:
    """Compare integer row versions and raise a safe structured conflict on mismatch."""
    current = getattr(entity, "row_version", None)
    if current is None:
        raise ValueError(f"{entity_type} missing row_version")
    current_version = int(current)
    expected_version = int(expected)
    if current_version != expected_version:
        raise InventoryConflictError(
            STALE_INVENTORY_DETAIL,
            code=STALE_VERSION_CODE,
            conflicts=[
                {
                    "entity_type": entity_type,
                    "entity_id": entity_id,
                    "expected_row_version": expected_version,
                    "current_row_version": current_version,
                }
            ],
        )


def bump_ingredient_collection(ingredient: Ingredient, *, user_id: str) -> None:
    """Advance the parent Ingredient collection token for child inventory mutations."""
    ingredient.row_version += 1
    ingredient.updated_by = user_id


def conflict_detail(error: InventoryConflictError) -> dict[str, Any] | str:
    """HTTP-safe conflict payload; keep legacy string detail when no structured conflicts."""
    if not error.conflicts:
        return error.message or STALE_INVENTORY_DETAIL
    return {
        "code": error.code,
        "message": error.message or STALE_INVENTORY_DETAIL,
        "conflicts": error.conflicts,
    }
