from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Enum as SqlEnum, Float, ForeignKey, Index, Integer, JSON, LargeBinary, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.enums import (
    ActivityAction,
    ActivityHighlightKind,
    AiMode,
    AIConversationVisibility,
    Difficulty,
    FoodType,
    ImageGenerationMode,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    InventoryStatus,
    MealLogRecordStatus,
    MealLogRecordTargetKind,
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
    food_preferences: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    food_avoidances: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ingredients: Mapped[list["Ingredient"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ingredient_inventory_states: Mapped[list["IngredientInventoryState"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    inventory_operations: Mapped[list["InventoryOperation"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    shopping_items: Mapped[list["ShoppingListItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    recipes: Mapped[list["Recipe"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    food_scenes: Mapped[list["FoodScene"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    food_plan_items: Mapped[list["FoodPlanItem"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    foods: Mapped[list["Food"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    meal_logs: Mapped[list["MealLog"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    activity_logs: Mapped[list["ActivityLog"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    media_assets: Mapped[list["MediaAsset"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_conversations: Mapped[list["AIConversation"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_recommendations: Mapped[list["AIRecommendation"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_agent_runs: Mapped[list["AIAgentRun"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_messages: Mapped[list["AIMessage"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_run_events: Mapped[list["AIRunEvent"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_task_drafts: Mapped[list["AITaskDraft"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_approval_requests: Mapped[list["AIApprovalRequest"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_user_approvals: Mapped[list["AIUserApproval"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_operations: Mapped[list["AIOperation"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    ai_image_generation_jobs: Mapped[list["AIImageGenerationJob"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    search_documents: Mapped[list["SearchDocument"]] = relationship(back_populates="family", cascade="all, delete-orphan")
    search_index_jobs: Mapped[list["SearchIndexJob"]] = relationship(back_populates="family", cascade="all, delete-orphan")


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
    food_plan_items: Mapped[list["FoodPlanItem"]] = relationship(back_populates="user", cascade="all, delete-orphan")


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
    __table_args__ = (
        CheckConstraint(
            "(highlight_kind IS NULL AND highlight_summary IS NULL) OR "
            "(highlight_kind IS NOT NULL AND highlight_summary IS NOT NULL)",
            name="ck_activity_logs_highlight_pair",
        ),
        Index(
            "ix_activity_logs_family_created_highlight",
            "family_id",
            "created_at",
            "highlight_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("activity"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    action: Mapped[ActivityAction] = mapped_column(SqlEnum(ActivityAction, native_enum=False), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    summary: Mapped[str] = mapped_column(String(255), nullable=False)
    highlight_kind: Mapped[ActivityHighlightKind | None] = mapped_column(
        SqlEnum(ActivityHighlightKind, native_enum=False),
        nullable=True,
    )
    highlight_summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="activity_logs")


class SearchDocument(Base):
    __tablename__ = "search_documents"
    __table_args__ = (
        UniqueConstraint("family_id", "entity_type", "entity_id", name="uq_search_documents_entity"),
        Index("ix_search_documents_family_scope", "family_id", "entity_type", "updated_at"),
        Index("ix_search_documents_vector_status", "vector_status", "last_vector_attempt_at", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("search-doc"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    title_text: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    keyword_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    detail_text: Mapped[str] = mapped_column(Text().with_variant(mysql.MEDIUMTEXT(), "mysql"), default="", nullable=False)
    semantic_text: Mapped[str] = mapped_column(Text().with_variant(mysql.MEDIUMTEXT(), "mysql"), default="", nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    document_builder_version: Mapped[str] = mapped_column(String(32), nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    embedding_dimensions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    vector_status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    vector_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    vector_attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_vector_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="search_documents")


class Ingredient(AuditMixin, Base):
    __tablename__ = "ingredients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ingredient"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(120), default="未分类", nullable=False)
    default_unit: Mapped[str] = mapped_column(String(32), default="个", nullable=False)
    unit_conversions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    quantity_tracking_mode: Mapped[IngredientQuantityTrackingMode] = mapped_column(
        SqlEnum(IngredientQuantityTrackingMode, native_enum=False),
        default=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        nullable=False,
    )
    default_storage: Mapped[str] = mapped_column(String(120), default="冷藏", nullable=False)
    default_expiry_mode: Mapped[IngredientExpiryMode] = mapped_column(
        SqlEnum(IngredientExpiryMode, native_enum=False),
        default=IngredientExpiryMode.NONE,
        nullable=False,
    )
    default_expiry_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_low_stock_threshold: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    family: Mapped["Family"] = relationship(back_populates="ingredients")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="ingredient", cascade="all, delete-orphan")
    inventory_state: Mapped["IngredientInventoryState | None"] = relationship(
        back_populates="ingredient",
        cascade="all, delete-orphan",
        uselist=False,
    )
    shopping_items: Mapped[list["ShoppingListItem"]] = relationship(back_populates="ingredient")

    __mapper_args__ = {"version_id_col": row_version}


class InventoryItem(AuditMixin, Base):
    __tablename__ = "inventory_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    consumed_quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0, nullable=False)
    disposed_quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0, nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    entered_quantity: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    entered_unit: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[InventoryStatus] = mapped_column(SqlEnum(InventoryStatus, native_enum=False), nullable=False)
    purchase_date: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    storage_location: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    low_stock_threshold: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0, nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    expiry_alert_snoozed_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiry_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expiry_reviewed_by: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_confirmed_by: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_confirmation_source: Mapped[InventoryConfirmationSource | None] = mapped_column(
        SqlEnum(InventoryConfirmationSource, native_enum=False),
        nullable=True,
    )

    family: Mapped["Family"] = relationship(back_populates="inventory_items")
    ingredient: Mapped["Ingredient"] = relationship(back_populates="inventory_items")

    __mapper_args__ = {"version_id_col": row_version}


class IngredientInventoryState(AuditMixin, Base):
    __tablename__ = "ingredient_inventory_states"
    __table_args__ = (
        UniqueConstraint("family_id", "ingredient_id", name="uq_ingredient_inventory_states_family_ingredient"),
        Index("ix_ingredient_inventory_states_family_availability", "family_id", "availability_level"),
        Index(
            "ix_ingredient_inventory_states_family_storage_availability",
            "family_id",
            "storage_location",
            "availability_level",
        ),
        Index("ix_ingredient_inventory_states_family_expiry", "family_id", "expiry_date"),
        Index("ix_ingredient_inventory_states_family_confirmed", "family_id", "last_confirmed_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory-state"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    availability_level: Mapped[InventoryAvailabilityLevel] = mapped_column(
        SqlEnum(InventoryAvailabilityLevel, native_enum=False),
        nullable=False,
    )
    inventory_status: Mapped[InventoryStatus] = mapped_column(
        SqlEnum(InventoryStatus, native_enum=False),
        default=InventoryStatus.FRESH,
        nullable=False,
    )
    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    storage_location: Mapped[str | None] = mapped_column(String(120), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expiry_alert_snoozed_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiry_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expiry_reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_confirmed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_confirmation_source: Mapped[InventoryConfirmationSource | None] = mapped_column(
        SqlEnum(InventoryConfirmationSource, native_enum=False),
        nullable=True,
    )
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ingredient_inventory_states")
    ingredient: Mapped["Ingredient"] = relationship(back_populates="inventory_state")

    __mapper_args__ = {"version_id_col": row_version}


class InventoryOperation(Base):
    __tablename__ = "inventory_operations"
    __table_args__ = (
        UniqueConstraint("family_id", "client_request_id", name="uq_inventory_operations_family_request"),
        Index("ix_inventory_operations_family_applied", "family_id", "applied_at"),
        Index("ix_inventory_operations_family_status_revertible", "family_id", "status", "revertible_until"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory-operation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    operation_type: Mapped[InventoryOperationType] = mapped_column(
        SqlEnum(InventoryOperationType, native_enum=False),
        nullable=False,
    )
    status: Mapped[InventoryOperationStatus] = mapped_column(
        SqlEnum(InventoryOperationStatus, native_enum=False),
        nullable=False,
    )
    client_request_id: Mapped[str] = mapped_column(String(120), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revertible_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reverted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    summary_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="inventory_operations")
    lines: Mapped[list["InventoryOperationLine"]] = relationship(
        back_populates="operation",
        cascade="all, delete-orphan",
        order_by="InventoryOperationLine.sequence",
    )


class InventoryOperationLine(Base):
    __tablename__ = "inventory_operation_lines"
    __table_args__ = (
        UniqueConstraint("operation_id", "sequence", name="uq_inventory_operation_lines_sequence"),
        UniqueConstraint("operation_id", "entity_type", "entity_id", name="uq_inventory_operation_lines_entity"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory-operation-line"))
    operation_id: Mapped[str] = mapped_column(ForeignKey("inventory_operations.id", ondelete="CASCADE"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    entity_type: Mapped[InventoryOperationEntityType] = mapped_column(
        SqlEnum(InventoryOperationEntityType, native_enum=False),
        nullable=False,
    )
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    change_type: Mapped[InventoryOperationChangeType] = mapped_column(
        SqlEnum(InventoryOperationChangeType, native_enum=False),
        nullable=False,
    )
    before_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    after_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    before_row_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    after_row_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    change_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    snapshot_schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    operation: Mapped["InventoryOperation"] = relationship(back_populates="lines")


class ShoppingListItem(AuditMixin, Base):
    __tablename__ = "shopping_list_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("shopping"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_id: Mapped[str | None] = mapped_column(ForeignKey("ingredients.id", ondelete="SET NULL"), nullable=True, index=True)
    food_id: Mapped[str | None] = mapped_column(ForeignKey("foods.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    quantity_mode: Mapped[IngredientQuantityTrackingMode] = mapped_column(
        SqlEnum(IngredientQuantityTrackingMode, native_enum=False),
        default=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        nullable=False,
    )
    display_label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    reason: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    family: Mapped["Family"] = relationship(back_populates="shopping_items")
    ingredient: Mapped["Ingredient | None"] = relationship(back_populates="shopping_items")
    food: Mapped["Food | None"] = relationship(back_populates="shopping_items")

    __mapper_args__ = {"version_id_col": row_version}


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


class FoodScene(AuditMixin, Base):
    __tablename__ = "food_scenes"
    __table_args__ = (UniqueConstraint("family_id", "name", name="uq_food_scenes_family_name"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("food-scene"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    image_prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    custom: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="food_scenes")


class FoodPlanItem(AuditMixin, Base):
    __tablename__ = "food_plan_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("food-plan"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    food_id: Mapped[str] = mapped_column(ForeignKey("foods.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    meal_type: Mapped[MealType] = mapped_column(SqlEnum(MealType, native_enum=False), nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="planned", nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    meal_log_id: Mapped[str | None] = mapped_column(ForeignKey("meal_logs.id", ondelete="SET NULL"), nullable=True, index=True)

    family: Mapped["Family"] = relationship(back_populates="food_plan_items")
    user: Mapped["User"] = relationship(back_populates="food_plan_items")
    food: Mapped["Food"] = relationship(back_populates="plan_items")


class RecipeCookLog(AuditMixin, Base):
    __tablename__ = "recipe_cook_logs"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "completion_request_id",
            name="uq_recipe_cook_logs_family_completion_request",
        ),
    )

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
    completion_request_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    completion_request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    completion_result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    recipe: Mapped["Recipe"] = relationship(back_populates="cook_logs")


class Food(AuditMixin, Base):
    __tablename__ = "foods"
    __table_args__ = (UniqueConstraint("recipe_id", name="uq_foods_recipe_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("food"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    category: Mapped[str] = mapped_column(String(120), default="未分类", nullable=False)
    flavor_tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    scene_tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    suitable_meal_types: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    source_name: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    purchase_source: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    scene: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    routine_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    repurchase: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    stock_quantity: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    stock_unit: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    storage_location: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    recipe_id: Mapped[str | None] = mapped_column(ForeignKey("recipes.id", ondelete="SET NULL"), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    inventory_last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    inventory_last_confirmed_by: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    inventory_confirmation_source: Mapped[InventoryConfirmationSource | None] = mapped_column(
        SqlEnum(InventoryConfirmationSource, native_enum=False),
        nullable=True,
    )

    family: Mapped["Family"] = relationship(back_populates="foods")
    recipe: Mapped["Recipe | None"] = relationship(back_populates="foods")
    meal_entries: Mapped[list["MealLogFood"]] = relationship(back_populates="food", cascade="all, delete-orphan")
    plan_items: Mapped[list["FoodPlanItem"]] = relationship(back_populates="food", cascade="all, delete-orphan")
    shopping_items: Mapped[list["ShoppingListItem"]] = relationship(back_populates="food")

    __mapper_args__ = {"version_id_col": row_version}


class MealLog(AuditMixin, Base):
    __tablename__ = "meal_logs"
    __table_args__ = (
        Index("ix_meal_logs_family_date_type_created", "family_id", "date", "meal_type", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("meal"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    meal_type: Mapped[MealType] = mapped_column(SqlEnum(MealType, native_enum=False), nullable=False)
    participant_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    mood: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

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

    __mapper_args__ = {"version_id_col": row_version}


class MealLogFood(Base):
    __tablename__ = "meal_log_foods"
    __table_args__ = (
        Index("ix_meal_log_foods_log_food", "meal_log_id", "food_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("meal-food"))
    meal_log_id: Mapped[str] = mapped_column(ForeignKey("meal_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    food_id: Mapped[str] = mapped_column(ForeignKey("foods.id", ondelete="CASCADE"), nullable=False, index=True)
    servings: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    rating: Mapped[Decimal | None] = mapped_column(Numeric(2, 1), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    meal_log: Mapped["MealLog"] = relationship(back_populates="food_entries")
    food: Mapped["Food"] = relationship(back_populates="meal_entries")


class MealLogRecordOperation(Base):
    __tablename__ = "meal_log_record_operations"
    __table_args__ = (
        UniqueConstraint("family_id", "client_request_id", name="uq_meal_log_record_operations_family_request"),
        Index("ix_meal_log_record_operations_family_status_revertible", "family_id", "status", "revertible_until"),
        Index("ix_meal_log_record_operations_family_actor_applied", "family_id", "created_by", "applied_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("meal-record-op"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    client_request_id: Mapped[str] = mapped_column(String(120), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[MealLogRecordStatus] = mapped_column(
        SqlEnum(MealLogRecordStatus, native_enum=False),
        nullable=False,
    )
    target_kind: Mapped[MealLogRecordTargetKind] = mapped_column(
        SqlEnum(MealLogRecordTargetKind, native_enum=False),
        nullable=False,
    )
    meal_log_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_entry_ids_json: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_food_ids_json: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    result_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    revert_result_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revertible_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reverted_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


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
    variants: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="media_assets")


class AIImageGenerationJob(Base):
    __tablename__ = "ai_image_generation_jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("image-job"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False, index=True)
    request_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    reference_media_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    target_entity_type: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    target_entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    replace_anchor_media_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    generated_media_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    bind_status: Mapped[str | None] = mapped_column(String(32), default="pending", nullable=True, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ai_image_generation_jobs")


class SearchIndexJob(Base):
    __tablename__ = "search_index_jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("search-index-job"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    vector_status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="search_index_jobs")


class AIConversation(Base):
    __tablename__ = "ai_conversations"
    __table_args__ = (
        Index("ix_ai_conversations_family_owner_recent", "family_id", "owner_user_id", "last_message_at", "created_at"),
        Index("ix_ai_conversations_family_visibility_recent", "family_id", "visibility", "last_message_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("conversation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    visibility: Mapped[AIConversationVisibility] = mapped_column(
        SqlEnum(AIConversationVisibility, native_enum=False),
        default=AIConversationVisibility.PRIVATE,
        nullable=False,
    )
    mode: Mapped[AiMode] = mapped_column(SqlEnum(AiMode, native_enum=False), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    title: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    summary: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False, index=True)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_status: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_conversations")
    messages: Mapped[list["AIMessage"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by=lambda: AIMessage.created_at,
    )


class AIRecommendation(Base):
    __tablename__ = "ai_recommendations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("recommendation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ai_recommendations")


class AIAgentRun(Base):
    __tablename__ = "ai_agent_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("agent_run"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("ai_conversations.id", ondelete="SET NULL"), nullable=True, index=True)
    message_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    agent_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    feature_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    intent: Mapped[str] = mapped_column(String(80), default="", nullable=False, index=True)
    input_summary: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    context_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output_summary: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    input: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    tool_calls: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_agent_runs")


class AIMessage(Base):
    __tablename__ = "ai_messages"
    __table_args__ = (
        UniqueConstraint("family_id", "client_message_id", name="uq_ai_messages_family_client_message"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_message"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_type: Mapped[str] = mapped_column(String(32), default="text", nullable=False)
    parts: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="completed", nullable=False, index=True)
    message_metadata: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)
    client_message_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_messages")
    conversation: Mapped["AIConversation"] = relationship(back_populates="messages")


class AIRunEvent(Base):
    __tablename__ = "ai_run_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_run_event"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("ai_agent_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    internal_code: Mapped[str] = mapped_column(String(120), nullable=False)
    user_message: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ai_run_events")


class AIRunTraceSpan(Base):
    __tablename__ = "ai_run_trace_spans"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_span"))
    family_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    trace_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    span_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    parent_span_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    span_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    round_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attempt_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    input_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    exception_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AIRunLLMExchange(Base):
    __tablename__ = "ai_run_llm_exchanges"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_llm_exchange"))
    family_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    trace_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    span_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    provider_round: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt_index: Mapped[int] = mapped_column(Integer, nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    request_messages: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    request_tools: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    request_options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    request_original_digest: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    request_original_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    request_digest: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    request_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    request_truncated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    response_message: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    response_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_tool_calls: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    stream_chunks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    response_original_digest: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    response_original_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    response_digest: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    response_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    response_truncated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cached_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    token_usage: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

class AITaskDraft(Base):
    __tablename__ = "ai_task_drafts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_draft"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    source_run_id: Mapped[str | None] = mapped_column(ForeignKey("ai_agent_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("ai_messages.id", ondelete="SET NULL"), nullable=True, index=True)
    draft_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    preview_summary: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(32), default="recipe.v1", nullable=False)
    validation_errors: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    ai_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_task_drafts")


class AIApprovalRequest(Base):
    __tablename__ = "ai_approval_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_approval"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("ai_messages.id", ondelete="SET NULL"), nullable=True, index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("ai_agent_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    draft_id: Mapped[str] = mapped_column(ForeignKey("ai_task_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    draft_version: Mapped[int] = mapped_column(Integer, nullable=False)
    draft_schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    approval_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    request_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    field_schema: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    initial_values: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    submitted_values: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    decision: Mapped[str | None] = mapped_column(String(32), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_approval_requests")


class AIUserApproval(Base):
    __tablename__ = "ai_user_approvals"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_user_approval"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("ai_approval_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    draft_id: Mapped[str] = mapped_column(ForeignKey("ai_task_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    approved_by: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    approved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    decision: Mapped[str] = mapped_column(String(32), nullable=False)
    approval_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    operation_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    family: Mapped["Family"] = relationship(back_populates="ai_user_approvals")


class AIOperation(Base):
    __tablename__ = "ai_operations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai_operation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("ai_approval_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    draft_id: Mapped[str] = mapped_column(ForeignKey("ai_task_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    operation_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    business_entity_type: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    business_entity_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="ai_operations")


class AIGraphCheckpoint(Base):
    __tablename__ = "ai_graph_checkpoints"
    __table_args__ = (
        UniqueConstraint("thread_id", "checkpoint_ns", "checkpoint_id", name="uq_ai_graph_checkpoint"),
    )

    id: Mapped[str] = mapped_column(String(191), primary_key=True)
    thread_id: Mapped[str] = mapped_column(String(191), nullable=False, index=True)
    checkpoint_ns: Mapped[str] = mapped_column(String(191), default="", nullable=False, index=True)
    checkpoint_id: Mapped[str] = mapped_column(String(191), nullable=False, index=True)
    parent_checkpoint_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    checkpoint_type: Mapped[str] = mapped_column(String(64), nullable=False)
    checkpoint_blob: Mapped[bytes] = mapped_column(LargeBinary(length=(2**32) - 1), nullable=False)
    metadata_type: Mapped[str] = mapped_column(String(64), nullable=False)
    metadata_blob: Mapped[bytes] = mapped_column(LargeBinary(length=(2**32) - 1), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class AIGraphWrite(Base):
    __tablename__ = "ai_graph_writes"
    __table_args__ = (
        UniqueConstraint(
            "thread_id",
            "checkpoint_ns",
            "checkpoint_id",
            "task_id",
            "write_idx",
            name="uq_ai_graph_write",
        ),
    )

    id: Mapped[str] = mapped_column(String(191), primary_key=True)
    thread_id: Mapped[str] = mapped_column(String(191), nullable=False, index=True)
    checkpoint_ns: Mapped[str] = mapped_column(String(191), default="", nullable=False, index=True)
    checkpoint_id: Mapped[str] = mapped_column(String(191), nullable=False, index=True)
    task_id: Mapped[str] = mapped_column(String(191), nullable=False)
    task_path: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    write_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    channel: Mapped[str] = mapped_column(String(191), nullable=False)
    value_type: Mapped[str] = mapped_column(String(64), nullable=False)
    value_blob: Mapped[bytes] = mapped_column(LargeBinary(length=(2**32) - 1), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
