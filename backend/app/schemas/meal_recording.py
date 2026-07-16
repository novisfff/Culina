from __future__ import annotations

from datetime import date as date_type, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.enums import FoodType, MealLogRecordStatus, MealType
from app.schemas.foods import FoodOut
from app.schemas.meal_logs import MealLogOut
from app.schemas.media import MediaAssetOut
from app.services.meal_log_foods import QUICK_RECORD_FOOD_TYPES


class MealLogCandidateFoodOut(BaseModel):
    food_id: str
    name: str
    food_type: str
    cover: MediaAssetOut | None = None


class MealLogCandidateOut(BaseModel):
    meal_log_id: str
    row_version: int
    date: date_type
    meal_type: MealType
    created_at: datetime
    foods: list[MealLogCandidateFoodOut]
    preview_media: MediaAssetOut | None = None
    photo_count: int


class RecordMealTargetNew(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["new"]


class RecordMealTargetExisting(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["existing"]
    meal_log_id: str
    expected_row_version: int = Field(ge=1)

    @field_validator("meal_log_id")
    @classmethod
    def _normalize_meal_log_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("meal_log_id 不能为空")
        return cleaned


RecordMealTarget = Annotated[
    RecordMealTargetNew | RecordMealTargetExisting,
    Field(discriminator="kind"),
]


class RecordMealNewFoodIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_food_id: str
    name: str
    type: FoodType

    @field_validator("client_food_id")
    @classmethod
    def _normalize_client_food_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("client_food_id 不能为空")
        return cleaned

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("食物名称不能为空")
        if len(cleaned) > 120:
            raise ValueError("食物名称不能超过 120 个字符")
        return cleaned

    @field_validator("type")
    @classmethod
    def _validate_type(cls, value: FoodType) -> FoodType:
        if value not in QUICK_RECORD_FOOD_TYPES:
            raise ValueError("不支持的快速记录食物类型")
        return value


class RecordMealEntryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    food_id: str | None = None
    client_food_id: str | None = None
    servings: Decimal = Field(gt=0)

    @field_validator("food_id", "client_food_id", mode="before")
    @classmethod
    def _normalize_optional_ids(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = str(value).strip()
        return cleaned or None

    @model_validator(mode="after")
    def _exactly_one_reference(self) -> "RecordMealEntryIn":
        has_food = self.food_id is not None
        has_client = self.client_food_id is not None
        if has_food == has_client:
            raise ValueError("每个 entry 必须且只能提供 food_id 或 client_food_id")
        return self


class RecordMealRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_request_id: str = Field(min_length=1, max_length=120)
    date: date_type
    meal_type: MealType
    target: RecordMealTarget
    new_foods: list[RecordMealNewFoodIn] = Field(default_factory=list)
    entries: list[RecordMealEntryIn] = Field(min_length=1)

    @field_validator("client_request_id")
    @classmethod
    def _normalize_client_request_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("client_request_id 不能为空")
        if len(cleaned) > 120:
            raise ValueError("client_request_id 不能超过 120 个字符")
        return cleaned

    @model_validator(mode="after")
    def _validate_references(self) -> "RecordMealRequest":
        client_ids = [item.client_food_id for item in self.new_foods]
        if len(client_ids) != len(set(client_ids)):
            raise ValueError("new_foods 中 client_food_id 必须唯一")

        known_client_ids = set(client_ids)
        referenced_client_ids: set[str] = set()
        existing_food_ids: list[str] = []
        for entry in self.entries:
            if entry.client_food_id is not None:
                if entry.client_food_id not in known_client_ids:
                    raise ValueError("entries 引用了未知的 client_food_id")
                referenced_client_ids.add(entry.client_food_id)
            if entry.food_id is not None:
                existing_food_ids.append(entry.food_id)

        if known_client_ids - referenced_client_ids:
            raise ValueError("new_foods 必须被 entries 引用")
        if len(existing_food_ids) != len(set(existing_food_ids)):
            raise ValueError("同一食物不能重复加入一餐")

        return self


class MealLogRecordOperationOut(BaseModel):
    id: str
    status: MealLogRecordStatus
    revertible_until: datetime
    can_revert: bool
    # Effect-scoped entry ids created by this record operation (for rating / summary).
    created_entry_ids: list[str] = []


class RecordMealResponse(BaseModel):
    meal_log: MealLogOut
    created_foods: list[FoodOut]
    outcome: Literal["created", "appended", "replayed"]
    operation: MealLogRecordOperationOut


class MealLogRecordOperationFoodSummaryOut(BaseModel):
    food_id: str
    name: str
    food_type: str
    cover: MediaAssetOut | None = None


class MealLogRecordOperationSummaryOut(BaseModel):
    id: str
    meal_log_id: str
    foods: list[MealLogRecordOperationFoodSummaryOut]
    preview_media: MediaAssetOut | None = None
    revertible_until: datetime
    can_revert: bool


class RevertMealRecordResponse(BaseModel):
    status: Literal["reverted"]
    meal_log: MealLogOut | None
    removed_food_ids: list[str]
    replayed: bool
