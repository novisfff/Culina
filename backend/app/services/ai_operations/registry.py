from __future__ import annotations

from app.services.ai_operations.registry_specs import build_draft_operation_specs
from app.services.ai_operations.registry_types import DraftOperationRegistry


draft_operation_registry = DraftOperationRegistry(build_draft_operation_specs())
