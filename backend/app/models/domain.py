from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Enum as SqlEnum, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.enums import (
    ActivityAction,
    AiMode,
    Difficulty,
    FoodType,
    ImageGenerationMode,
    IngredientExpiryMode,
    InventoryStatus,
    MealType,
    MediaSource,
    MembershipStatus,
    UserRole,
)
from app.core.utils import create_id, utcnow


class Base(DeclarativeBase):
    pass


class AuditMixin:
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Family(AuditMixin, Base):
    __tablename__ = "families"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("family"))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    motto: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    location: Mapped[str] = mapped_column(String(120), default="", nullable=False)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ingredients: Mapped[list["Ingredient"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    shopping_items: Mapped[list["ShoppingListItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    recipes: Mapped[list["Recipe"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    recipe_scenes: Mapped[list["RecipeScene"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    recipe_favorites: Mapped[list["RecipeFavorite"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    recipe_plan_items: Mapped[list["RecipePlanItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    foods: Mapped[list["Food"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    meal_logs: Mapped[list["MealLog"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    activity_logs: Mapped[list["ActivityLog"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    media_assets: Mapped[list["MediaAsset"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_conversations: Mapped[list["AIConversation"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_recommendations: Mapped[list["AIRecommendation"]] = relationship(back_populates="family", cascade="all, delete-orphan")


class User(AuditMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("user"))
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    avatar_seed: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    credential: Mapped["UserCredential"] = relationship(back_populates="user", cascade="all, delete-orphan", uselist=False)
    memberships: Mapped[list["Membership"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    recipe_favorites: Mapped[list["RecipeFavorite"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    recipe_plan_items: Mapped[list["RecipePlanItem"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class UserCredential(Base):
    __tablename__ = "user_credentials"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("credential"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    user: Mapped["User"] = relationship(back_populates="credential")


class Membership(AuditMixin, Base):
    __tablename__ = "memberships"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("membership"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[UserRole] = mapped_column(SqlEnum(UserRole, native_enum=False), nullable=False)
    status: Mapped[MembershipStatus] = mapped_column(
        SqlEnum(MembershipStatus, native_enum=False),
        default=MembershipStatus.ACTIVE,
        nullable=False,
    )

    family: Mapped["Family"] = relationship(back_populates="memberships")
    user: Mapped["User"] = relationship(back_populates="memberships")


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("activity"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    action: Mapped[ActivityAction] = mapped_column(SqlEnum(ActivityAction, native_enum=False), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    summary: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="activity_logs")


class Ingredient(AuditMixin, Base):
    __tablename__ = "ingredients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ingredient"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(120), default="未分类", nullable=False)
    default_unit: Mapped[str] = mapped_column(String(32), default="个", nullable=False)
    unit_conversions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    default_storage: Mapped[str] = mapped_column(String(120), default="冷藏", nullable=False)
    default_expiry_mode: Mapped[IngredientExpiryMode] = mapped_column(
        SqlEnum(IngredientExpiryMode, native_enum=False),
        default=IngredientExpiryMode.NONE,
        nullable=False,
    )
    default_expiry_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_low_stock_threshold: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ingredients")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="ingredient", cascade="all, delete-orphan")


class InventoryItem(AuditMixin, Base):
    __tablename__ = "inventory_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    consumed_quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0, nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    entered_quantity: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    entered_unit: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[InventoryStatus] = mapped_column(SqlEnum(InventoryStatus, native_enum=False), nullable=False)
    purchase_date: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    storage_location: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    low_stock_threshold: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="inventory_items")
    ingredient: Mapped["Ingredient"] = relationship(back_populates="inventory_items")


class ShoppingListItem(AuditMixin, Base):
    __tablename__ = "shopping_list_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("shopping"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="shopping_items")


class Recipe(AuditMixin, Base):
    __tablename__ = "recipes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    servings: Mapped[int] = mapped_column(Integer, nullable=False)
    prep_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    difficulty: Mapped[Difficulty] = mapped_column(SqlEnum(Difficulty, native_enum=False), nullable=False)
    tips: Mapped[str] = mapped_column(Text, default="", nullable=False)
    scene_tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="recipes")
    ingredient_items: Mapped[list["RecipeIngredient"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
        order_by="RecipeIngredient.sort_order",
    )
    steps: Mapped[list["RecipeStep"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
        order_by="RecipeStep.sort_order",
    )
    foods: Mapped[list["Food"]] = relationship(back_populates="recipe")
    favorites: Mapped[list["RecipeFavorite"]] = relationship(back_populates="recipe", cascade="all, delete-orphan")
    plan_items: Mapped[list["RecipePlanItem"]] = relationship(back_populates="recipe", cascade="all, delete-orphan")
    cook_logs: Mapped[list["RecipeCookLog"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
        order_by=lambda: RecipeCookLog.created_at.desc(),
    )


class RecipeIngredient(Base):
    __tablename__ = "recipe_ingredients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe-ingredient"))
    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_id: Mapped[str | None] = mapped_column(ForeignKey("ingredients.id", ondelete="SET NULL"), nullable=True)
    ingredient_name: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    recipe: Mapped["Recipe"] = relationship(back_populates="ingredient_items")


class RecipeStep(Base):
    __tablename__ = "recipe_steps"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("step"))
    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str | None] = mapped_column(String(80), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    icon: Mapped[str] = mapped_column(String(32), default="pan", nullable=False)
    summary: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tip: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    key_points: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    recipe: Mapped["Recipe"] = relationship(back_populates="steps")


class RecipeScene(AuditMixin, Base):
    __tablename__ = "recipe_scenes"
    __table_args__ = (UniqueConstraint("family_id", "name", name="uq_recipe_scenes_family_name"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe-scene"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    image_prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    custom: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="recipe_scenes")


class RecipeFavorite(Base):
    __tablename__ = "recipe_favorites"
    __table_args__ = (UniqueConstraint("user_id", "recipe_id", name="uq_recipe_favorites_user_recipe"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe-favorite"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="recipe_favorites")
    user: Mapped["User"] = relationship(back_populates="recipe_favorites")
    recipe: Mapped["Recipe"] = relationship(back_populates="favorites")


class RecipePlanItem(AuditMixin, Base):
    __tablename__ = "recipe_plan_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe-plan"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    meal_type: Mapped[MealType] = mapped_column(SqlEnum(MealType, native_enum=False), nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="planned", nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    meal_log_id: Mapped[str | None] = mapped_column(ForeignKey("meal_logs.id", ondelete="SET NULL"), nullable=True, index=True)

    family: Mapped["Family"] = relationship(back_populates="recipe_plan_items")
    user: Mapped["User"] = relationship(back_populates="recipe_plan_items")
    recipe: Mapped["Recipe"] = relationship(back_populates="plan_items")


class RecipeCookLog(AuditMixin, Base):
    __tablename__ = "recipe_cook_logs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recipe-cook"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    meal_log_id: Mapped[str | None] = mapped_column(ForeignKey("meal_logs.id", ondelete="SET NULL"), nullable=True, index=True)
    cook_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    meal_type: Mapped[MealType] = mapped_column(SqlEnum(MealType, native_enum=False), nullable=False)
    servings: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    result_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    adjustments: Mapped[str] = mapped_column(Text, default="", nullable=False)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    recipe: Mapped["Recipe"] = relationship(back_populates="cook_logs")


class Food(AuditMixin, Base):
    __tablename__ = "foods"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("food"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[FoodType] = mapped_column(SqlEnum(FoodType, native_enum=False), nullable=False)
    category: Mapped[str] = mapped_column(String(120), default="未分类", nullable=False)
    flavor_tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    source_name: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    scene: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    recipe_id: Mapped[str | None] = mapped_column(ForeignKey("recipes.id", ondelete="SET NULL"), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="foods")
    recipe: Mapped["Recipe | None"] = relationship(back_populates="foods")
    meal_entries: Mapped[list["MealLogFood"]] = relationship(back_populates="food")


class MealLog(AuditMixin, Base):
    __tablename__ = "meal_logs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("meal"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    meal_type: Mapped[MealType] = mapped_column(SqlEnum(MealType, native_enum=False), nullable=False)
    participant_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    mood: Mapped[str] = mapped_column(String(120), default="", nullable=False)

    family: Mapped["Family"] = relationship(back_populates="meal_logs")
    food_entries: Mapped[list["MealLogFood"]] = relationship(
        back_populates="meal_log",
        cascade="all, delete-orphan",
        order_by="MealLogFood.created_at",
    )
    deduction_suggestions: Mapped[list["InventoryDeductionSuggestion"]] = relationship(
        back_populates="meal_log",
        cascade="all, delete-orphan",
        order_by="InventoryDeductionSuggestion.created_at",
    )


class MealLogFood(Base):
    __tablename__ = "meal_log_foods"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("meal-food"))
    meal_log_id: Mapped[str] = mapped_column(ForeignKey("meal_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    food_id: Mapped[str] = mapped_column(ForeignKey("foods.id", ondelete="CASCADE"), nullable=False, index=True)
    servings: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    meal_log: Mapped["MealLog"] = relationship(back_populates="food_entries")
    food: Mapped["Food"] = relationship(back_populates="meal_entries")


class InventoryDeductionSuggestion(Base):
    __tablename__ = "inventory_deduction_suggestions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("suggestion"))
    meal_log_id: Mapped[str] = mapped_column(ForeignKey("meal_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_name: Mapped[str] = mapped_column(String(120), nullable=False)
    suggested_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    based_on_food_name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    meal_log: Mapped["MealLog"] = relationship(back_populates="deduction_suggestions")


class MediaAsset(Base):
    __tablename__ = "media_assets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("photo"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[MediaSource] = mapped_column(SqlEnum(MediaSource, native_enum=False), nullable=False)
    alt: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    generation_mode: Mapped[ImageGenerationMode | None] = mapped_column(
        SqlEnum(ImageGenerationMode, native_enum=False), nullable=True
    )
    reference_media_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    style_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="media_assets")


class AIConversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("conversation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    mode: Mapped[AiMode] = mapped_column(SqlEnum(AiMode, native_enum=False), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_conversations")


class AIRecommendation(Base):
    __tablename__ = "ai_recommendations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recommendation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ai_recommendations")
