from __future__ import annotations

from dataclasses import replace

from app.services.ai_operations.draft_specs.common import DRAFT_APPROVAL_BASE_CONFIGS
from app.services.ai_operations.draft_specs.composite import composite_operation_specs
from app.services.ai_operations.draft_specs.inventory import inventory_operation_specs
from app.services.ai_operations.draft_specs.inventory_intake import inventory_intake_operation_specs
from app.services.ai_operations.draft_specs.planning import planning_operation_specs
from app.services.ai_operations.draft_specs.profiles import profile_operation_specs
from app.services.ai_operations.draft_specs.recipes import recipe_operation_specs
from app.services.ai_operations.foods import execute_food_profile_draft_receipt
from app.services.ai_operations.meal_logs import execute_meal_log_draft_receipt
from app.services.ai_operations.meal_plans import execute_meal_plan_draft_receipt
from app.services.ai_operations.registry_types import DraftOperationSpec
from app.services.ai_operations.shopping import execute_shopping_list_draft_receipt


def build_draft_operation_specs() -> list[DraftOperationSpec]:
    specs = [
        *recipe_operation_specs(),
        *planning_operation_specs(),
        *profile_operation_specs(),
        *inventory_operation_specs(),
        *inventory_intake_operation_specs(),
        *composite_operation_specs(),
    ]
    receipt_executors = {
        "food_profile": execute_food_profile_draft_receipt,
        "meal_log": execute_meal_log_draft_receipt,
        "meal_plan": execute_meal_plan_draft_receipt,
        "shopping_list": execute_shopping_list_draft_receipt,
    }
    return [
        replace(spec, execute=receipt_executors.get(spec.draft_type, spec.execute))
        for spec in specs
    ]
