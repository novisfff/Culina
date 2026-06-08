from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import AiMode, Difficulty
from app.schemas.recipes import RecipeIngredientIn, RecipeStepIn


class AIConversationOut(BaseModel):
    id: str
    family_id: str
    mode: AiMode
    prompt: str
    response: str
    created_at: datetime
    created_by: str | None = None
    context: dict
    title: str = ""
    summary: str = ""
    status: str = "active"
    last_message_at: datetime | None = None
    last_run_status: str = ""


class AIRecommendationOut(BaseModel):
    id: str
    family_id: str
    title: str
    detail: str
    created_at: datetime


class AIQueryRequest(BaseModel):
    mode: AiMode
    prompt: str = ""
    food_id: str | None = None
    ingredient_ids: list[str] = Field(default_factory=list)


class AIQueryResponse(BaseModel):
    conversation: AIConversationOut
    recommendation: AIRecommendationOut | None = None


class AIRecipeDraftOut(BaseModel):
    title: str
    servings: int
    prep_minutes: int
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientIn]
    steps: list[RecipeStepIn]
    tips: str = ""
    scene_tags: list[str] = Field(default_factory=list)
    media_ids: list[str] = Field(default_factory=list)


class GenerateRecipeDraftRequest(BaseModel):
    title: str = ""
    prompt: str = ""
    ingredient_ids: list[str] = Field(default_factory=list)
    extra_ingredients: list[str] = Field(default_factory=list)
    servings: int | None = None
    prep_minutes: int | None = None
    difficulty: Difficulty | None = None
    scene_tags: list[str] = Field(default_factory=list)
    generate_image: bool = True


class GenerateRecipeDraftResponse(BaseModel):
    draft: AIRecipeDraftOut | None = None
    agent_run_id: str
    status: Literal["completed", "failed"]
    error: str | None = None
    image_render_payload: dict | None = None


AIMessageRole = Literal["user", "assistant", "system"]
AIMessagePartType = Literal["text", "result_card", "draft", "approval_request", "error_recovery"]
AIResultCardType = Literal[
    "today_recommendation",
    "recipe_draft",
    "approval_request",
    "error_recovery",
    "inventory_summary",
    "meal_plan_draft",
    "shopping_list_draft",
    "meal_log_draft",
    "food_profile_draft",
]
AIRunEventStatus = Literal["pending", "running", "completed", "failed"]
AITaskDraftType = Literal["recipe", "shopping_list", "meal_plan", "meal_log", "food_profile"]
AITaskDraftStatus = Literal["pending", "confirmed", "rejected", "confirmation_failed", "pending_retry"]
AIApprovalStatus = Literal["pending", "approved", "rejected", "cancelled", "expired"]
AIApprovalDecision = Literal["approved", "rejected"]


class AISubjectIn(BaseModel):
    source: str | None = None
    recipe_id: str | None = None
    food_id: str | None = None
    ingredient_ids: list[str] = Field(default_factory=list)
    date_range: dict | None = None
    extra: dict = Field(default_factory=dict)


class AIChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    client_message_id: str | None = None
    client_run_id: str | None = None
    quick_task: str | None = None
    subject: AISubjectIn | None = None


class AIResultCardDTO(BaseModel):
    id: str
    type: AIResultCardType
    title: str
    data: dict = Field(default_factory=dict)


class AITaskDraftDTO(BaseModel):
    id: str
    conversation_id: str
    message_id: str | None = None
    run_id: str | None = None
    draft_type: AITaskDraftType
    payload: dict = Field(default_factory=dict)
    preview_summary: str
    status: AITaskDraftStatus | str
    version: int
    schema_version: str
    validation_errors: list[dict] = Field(default_factory=list)
    expires_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class AIApprovalFieldDTO(BaseModel):
    name: str
    label: str
    type: Literal["string", "number", "integer", "boolean", "array", "object"]
    widget: Literal["input", "textarea", "switch", "select", "radio", "checkbox_group", "tag_selector", "date", "time", "recipe_draft_editor"]
    options: list[str | dict] | None = None
    allow_custom: bool = False
    placeholder: str | None = None
    required: bool = False


class AIApprovalRequestDTO(BaseModel):
    id: str
    conversation_id: str
    message_id: str | None = None
    run_id: str | None = None
    draft_id: str
    draft_version: int
    draft_schema_version: str
    approval_type: str
    status: AIApprovalStatus | str
    title: str
    instruction: str
    approve_label: str
    reject_label: str
    require_reject_comment: bool
    field_schema: list[AIApprovalFieldDTO]
    initial_values: dict = Field(default_factory=dict)
    submitted_values: dict = Field(default_factory=dict)
    decision: AIApprovalDecision | None = None
    comment: str | None = None
    resolved_at: datetime | None = None
    expires_at: datetime | None = None
    created_at: datetime


class AIMessagePartDTO(BaseModel):
    id: str
    type: AIMessagePartType
    text: str | None = None
    card: AIResultCardDTO | None = None
    draft: AITaskDraftDTO | None = None
    approval: AIApprovalRequestDTO | None = None


class AIMessageDTO(BaseModel):
    id: str
    conversation_id: str
    role: AIMessageRole
    content: str
    content_type: str
    parts: list[AIMessagePartDTO]
    run_id: str | None = None
    status: str
    metadata: dict = Field(default_factory=dict)
    client_message_id: str | None = None
    created_at: datetime


class AIRunDTO(BaseModel):
    id: str
    agent_key: str
    intent: str
    status: str
    model: str = ""
    created_at: datetime


class AIRunEventDTO(BaseModel):
    id: str
    run_id: str
    type: str
    internal_code: str
    user_message: str
    status: AIRunEventStatus
    created_at: datetime


class AIResponseIncludedDTO(BaseModel):
    result_cards: list[AIResultCardDTO] = Field(default_factory=list)
    drafts: list[AITaskDraftDTO] = Field(default_factory=list)
    approvals: list[AIApprovalRequestDTO] = Field(default_factory=list)


class AIChatResponse(BaseModel):
    conversation_id: str
    message: AIMessageDTO
    run: AIRunDTO
    events: list[AIRunEventDTO] = Field(default_factory=list)
    included: AIResponseIncludedDTO = Field(default_factory=AIResponseIncludedDTO)


class AIApprovalDecisionRequest(BaseModel):
    decision: AIApprovalDecision
    draft_version: int
    values: dict = Field(default_factory=dict)
    comment: str | None = None


class AIApprovalDecisionResponse(BaseModel):
    approval: AIApprovalRequestDTO
    draft: AITaskDraftDTO
    operation: dict | None = None
    business_entity: dict | None = None
