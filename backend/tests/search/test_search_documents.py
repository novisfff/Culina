from __future__ import annotations

from decimal import Decimal

from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.core.enums import Difficulty, FoodType, IngredientExpiryMode, IngredientQuantityTrackingMode, MealType
from app.models.domain import Food, Ingredient, Recipe, RecipeIngredient, RecipeStep, SearchDocument
from app.services.search.documents import build_food_search_document, build_ingredient_search_document, build_recipe_search_document


def test_builds_ingredient_search_document_with_semantic_context() -> None:
    ingredient = Ingredient(
        id="ingredient-tomato",
        family_id="family-1",
        name="番茄",
        category="蔬菜",
        default_unit="个",
        unit_conversions=[{"unit": "斤", "factor": 2}],
        quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        default_storage="冷藏",
        default_expiry_mode=IngredientExpiryMode.DAYS,
        default_expiry_days=5,
        default_low_stock_threshold=Decimal("2"),
        notes="适合做汤和快手晚餐",
    )

    document = build_ingredient_search_document(ingredient, embedding_model="model-a", embedding_dimensions=1024)

    assert document.entity_type == "ingredient"
    assert document.title_text == "番茄"
    assert "蔬菜" in document.keyword_text
    assert "斤" in document.detail_text
    assert "食材：番茄" in document.semantic_text
    assert "备注：适合做汤和快手晚餐" in document.semantic_text
    assert document.metadata_json["quantity_tracking_mode"] == "track_quantity"
    assert document.embedding_model == "model-a"
    assert document.embedding_dimensions == 1024


def test_builds_food_search_document_without_dynamic_stock_context() -> None:
    food = Food(
        id="food-yogurt",
        family_id="family-1",
        name="酸奶",
        type=FoodType.READY_MADE.value,
        category="乳制品",
        flavor_tags=["清爽"],
        scene_tags=["早餐"],
        suitable_meal_types=[MealType.BREAKFAST.value, MealType.SNACK.value],
        source_name="超市",
        purchase_source="本地超市",
        scene="加餐",
        notes="孩子喜欢",
        routine_note="早上搭配麦片",
        stock_quantity=Decimal("3"),
        stock_unit="盒",
    )

    document = build_food_search_document(food)

    assert document.entity_type == "food"
    assert "适合餐别：breakfast、snack" in document.semantic_text
    assert "日常说明：早上搭配麦片" in document.semantic_text
    assert "3" not in document.semantic_text
    assert "盒" not in document.semantic_text


def test_builds_recipe_search_document_from_ingredients_and_steps() -> None:
    recipe = Recipe(
        id="recipe-soup",
        family_id="family-1",
        title="番茄鸡蛋汤",
        servings=2,
        prep_minutes=15,
        difficulty=Difficulty.EASY,
        tips="出锅前再放葱花",
        scene_tags=["晚餐", "清淡"],
    )
    recipe.ingredient_items = [
        RecipeIngredient(
            id="ri-1",
            recipe_id=recipe.id,
            ingredient_id="ingredient-tomato",
            ingredient_name="番茄",
            quantity=Decimal("2"),
            unit="个",
            note="切块",
            sort_order=0,
        )
    ]
    recipe.steps = [
        RecipeStep(
            id="step-1",
            recipe_id=recipe.id,
            title="煮汤",
            text="番茄炒软后加水，倒入蛋液。",
            icon="pan",
            summary="先炒番茄再加水",
            estimated_minutes=10,
            tip="小火倒蛋液",
            key_points=["清淡", "快手"],
            sort_order=0,
        )
    ]

    document = build_recipe_search_document(recipe)

    assert document.entity_type == "recipe"
    assert "番茄" in document.keyword_text
    assert "煮汤" in document.keyword_text
    assert "菜谱：番茄鸡蛋汤" in document.semantic_text
    assert "食材：番茄 2 个 切块" in document.semantic_text
    assert "步骤：煮汤 先炒番茄再加水 清淡、快手 番茄炒软后加水，倒入蛋液。 小火倒蛋液" in document.semantic_text


def test_content_hash_changes_with_embedding_model_and_dimensions() -> None:
    ingredient = Ingredient(
        id="ingredient-tomato",
        family_id="family-1",
        name="番茄",
        category="蔬菜",
        default_unit="个",
        unit_conversions=[],
        quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        default_storage="冷藏",
        default_expiry_mode=IngredientExpiryMode.NONE,
        notes="",
    )

    first = build_ingredient_search_document(ingredient, embedding_model="model-a", embedding_dimensions=1024)
    second = build_ingredient_search_document(ingredient, embedding_model="model-b", embedding_dimensions=1024)
    third = build_ingredient_search_document(ingredient, embedding_model="model-a", embedding_dimensions=768)

    assert first.content_hash != second.content_hash
    assert first.content_hash != third.content_hash


def test_search_document_mysql_ddl_uses_mediumtext_for_long_context_fields() -> None:
    ddl = str(CreateTable(SearchDocument.__table__).compile(dialect=mysql.dialect()))

    assert "detail_text MEDIUMTEXT NOT NULL" in ddl
    assert "semantic_text MEDIUMTEXT NOT NULL" in ddl
