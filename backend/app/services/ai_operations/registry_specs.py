from __future__ import annotations

from app.services.ai_operations.draft_specs.common import DRAFT_APPROVAL_BASE_CONFIGS
from app.services.ai_operations.draft_specs.composite import composite_operation_specs
from app.services.ai_operations.draft_specs.inventory import inventory_operation_specs
from app.services.ai_operations.draft_specs.planning import planning_operation_specs
from app.services.ai_operations.draft_specs.profiles import profile_operation_specs
from app.services.ai_operations.draft_specs.recipes import recipe_operation_specs
from app.services.ai_operations.registry_types import DraftOperationSpec


def build_draft_operation_specs() -> list[DraftOperationSpec]:
    return [
        *recipe_operation_specs(),
        *planning_operation_specs(),
        *profile_operation_specs(),
        *inventory_operation_specs(),
        *composite_operation_specs(),
    ]
