from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.core.enums import InventoryOperationStatus, InventoryOperationType


SNAPSHOT_SCHEMA_VERSION = 1


class InventoryOperationDisplaySummary(BaseModel):
    title: str
    description: str
    confirmed_count: int = 0
    adjusted_count: int = 0
    completed_count: int = 0
    partial_count: int = 0


class InventoryOperationResult(BaseModel):
    operation_id: str
    operation_type: InventoryOperationType
    status: InventoryOperationStatus
    applied_at: datetime
    revertible_until: datetime
    can_revert: bool
    summary: InventoryOperationDisplaySummary
