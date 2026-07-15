from fastapi import APIRouter


from app.api.activity_highlights import router as activity_highlights_router
from app.api.activity_logs import router as activity_logs_router
from app.api.ai import router as ai_router
from app.api.ai_audio import router as ai_audio_router
from app.api.auth import router as auth_router
from app.api.family import router as family_router
from app.api.foods import router as foods_router
from app.api.ingredients import router as ingredients_router
from app.api.inventory import router as inventory_router
from app.api.inventory_reconciliation import router as inventory_reconciliation_router
from app.api.inventory_operations import router as inventory_operations_router
from app.api.inventory_states import router as inventory_states_router
from app.api.meal_log_recording import router as meal_log_recording_router
from app.api.meal_logs import router as meal_logs_router
from app.api.media import router as media_router
from app.api.recipe_meta import router as recipe_meta_router
from app.api.recipes import router as recipes_router
from app.api.search import router as search_router
from app.api.shopping_list import router as shopping_list_router
from app.api.shopping_intake import router as shopping_intake_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(family_router)
api_router.include_router(ingredients_router)
api_router.include_router(inventory_router)
api_router.include_router(inventory_states_router)
api_router.include_router(inventory_reconciliation_router)
api_router.include_router(inventory_operations_router)
api_router.include_router(shopping_list_router)
api_router.include_router(shopping_intake_router)
api_router.include_router(recipes_router)
api_router.include_router(recipe_meta_router)
api_router.include_router(foods_router)
api_router.include_router(meal_logs_router)
api_router.include_router(meal_log_recording_router)
api_router.include_router(activity_logs_router)
api_router.include_router(activity_highlights_router)
api_router.include_router(media_router)
api_router.include_router(search_router)
api_router.include_router(ai_router)
api_router.include_router(ai_audio_router)
