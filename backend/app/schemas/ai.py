from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import AiMode, Difficulty
from app.schemas.media import MediaAssetOut
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


class AIStatusResponse(BaseModel):
    enabled: bool
    provider: str
    model: str
    supports_vision: bool = False
    status: Literal["ready", "disabled", "missing_api_key", "unsupported_provider"]
    detail: str


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
AIMessagePartType = Literal[
    "text",
    "image",
    "result_card",
    "draft",
    "approval_request",
    "human_input_request",
    "error_recovery",
    "run_activity",
]
AIResultCardType = Literal[
    "today_recommendation",
    "recipe_draft",
    "approval_request",
    "error_recovery",
    "inventory_summary",
    "operation_result",
    "meal_plan_draft",
    "shopping_list_draft",
    "meal_log_draft",
    "food_profile_draft",
]
AIRunEventStatus = Literal["pending", "running", "waiting", "completed", "failed"]
AITaskDraftType = Literal[
    "recipe",
    "recipe_cook",
    "ingredient_profile",
    "shopping_list",
    "meal_plan",
    "meal_log",
    "food_profile",
    "inventory_operation",
    "composite_operation",
]
AITaskDraftStatus = Literal["pending", "confirmed", "rejected", "confirmation_failed", "pending_retry"]
AIApprovalStatus = Literal["pending", "approved", "rejected", "cancelled", "expired"]
AIApprovalDecision = Literal["approved", "rejected"]


class AISubjectIn(BaseModel):
    model_config = ConfigDict(extra="allow")

    source: str | None = Field(default=None, max_length=80)
    recipe_id: str | None = Field(default=None, max_length=64)
    food_id: str | None = Field(default=None, max_length=64)
    ingredient_ids: list[str] = Field(default_factory=list, max_length=50)
    date_range: dict | None = None
    extra: dict = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def normalize_reference_keys(cls, value):
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        aliases = {
            "recipeId": "recipe_id",
            "foodId": "food_id",
            "ingredientIds": "ingredient_ids",
            "dateRange": "date_range",
        }
        for source, target in aliases.items():
            if source in normalized and target not in normalized:
                normalized[target] = normalized[source]
        return normalized


class AIChatAttachmentIn(BaseModel):
    type: Literal["image"] = "image"
    media_id: str = Field(max_length=64)
    client_attachment_id: str | None = Field(default=None, max_length=120)

    @model_validator(mode="before")
    @classmethod
    def normalize_attachment_keys(cls, value):
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        if "mediaId" in normalized and "media_id" not in normalized:
            normalized["media_id"] = normalized["mediaId"]
        if "clientAttachmentId" in normalized and "client_attachment_id" not in normalized:
            normalized["client_attachment_id"] = normalized["clientAttachmentId"]
        return normalized


class AIChatRequest(BaseModel):
    message: str = Field(default="", max_length=2000)
    conversation_id: str | None = Field(default=None, max_length=64)
    client_message_id: str | None = Field(default=None, max_length=120)
    client_run_id: str | None = Field(default=None, max_length=64)
    quick_task: str | None = Field(default=None, max_length=80)
    subject: AISubjectIn | None = None
    attachments: list[AIChatAttachmentIn] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def validate_message_text(self) -> "AIChatRequest":
        if not self.message.strip() and not self.attachments:
            raise ValueError("消息不能为空")
        return self


class AIInventoryResultItemDTO(BaseModel):
    id: str
    ingredientId: str
    name: str
    image: dict | None = None
    quantity: str
    unit: str
    status: str
    displayStatus: Literal["available", "low_stock", "expiring", "expired"]
    expiryDate: str | None = None
    daysUntilExpiry: int | None = None
    lowStockThreshold: str | None = None


class AIInventorySummaryCardDataDTO(BaseModel):
    availableCount: int = Field(ge=0)
    expiringCount: int = Field(ge=0)
    lowStockCount: int = Field(ge=0)
    items: list[AIInventoryResultItemDTO] = Field(default_factory=list)


class AITodayRecommendationItemDTO(BaseModel):
    entityType: Literal["food", "recipe"]
    entityId: str
    foodId: str | None = None
    recipeId: str | None = None
    name: str
    image: dict | None = None
    category: str | None = None
    foodType: str | None = None
    prepMinutes: int | None = None
    servings: int | None = None
    difficulty: str | None = None
    reason: str
    evidence: list[dict] = Field(default_factory=list)
    planSelection: dict | None = None


class AITodayRecommendationContextDTO(BaseModel):
    inventoryCount: int = Field(ge=0)
    expiringCount: int = Field(ge=0)
    recentMealCount: int = Field(ge=0)
    recipeCount: int = Field(ge=0)


class AITodayRecommendationCardDataDTO(BaseModel):
    recommendations: list[AITodayRecommendationItemDTO] = Field(default_factory=list)
    targetDate: date | None = None
    mealType: Literal["breakfast", "lunch", "dinner", "snack"] | None = None
    contextSummary: AITodayRecommendationContextDTO


class AIOperationResultEntityDTO(BaseModel):
    id: str
    label: str
    operation: str | None = None
    operationLabel: str | None = None
    updatedAt: str | None = None


class AIOperationResultCardDataDTO(BaseModel):
    actionSummary: str = Field(min_length=1)
    entityCount: int = Field(ge=0)
    entityCountLabel: str = Field(min_length=1)
    workspaceLabel: str = Field(min_length=1)
    workspaceHint: str = Field(min_length=1)
    entities: list[AIOperationResultEntityDTO] = Field(default_factory=list)


class AIResultCardDTO(BaseModel):
    id: str
    type: AIResultCardType
    title: str
    data: dict

    @model_validator(mode="after")
    def validate_query_card_data(self) -> "AIResultCardDTO":
        if self.type == "inventory_summary":
            AIInventorySummaryCardDataDTO.model_validate(self.data)
        elif self.type == "today_recommendation":
            AITodayRecommendationCardDataDTO.model_validate(self.data)
        elif self.type == "operation_result":
            AIOperationResultCardDataDTO.model_validate(self.data)
        return self


class AIRecommendationSelectionRequest(BaseModel):
    part_id: str
    card_id: str
    entity_id: str
    food_plan_item_id: str


class AIInventoryQuickDraftRequest(BaseModel):
    part_id: str
    card_id: str
    item_id: str
    action: Literal["restock", "consume", "dispose"]


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
    failure_summary: dict | None = None
    field_schema: list[AIApprovalFieldDTO]
    initial_values: dict = Field(default_factory=dict)
    submitted_values: dict = Field(default_factory=dict)
    decision: AIApprovalDecision | None = None
    comment: str | None = None
    resolved_at: datetime | None = None
    expires_at: datetime | None = None
    created_at: datetime


class AIHumanInputOptionDTO(BaseModel):
    id: str
    label: str
    description: str | None = None


class AIHumanInputRequestDTO(BaseModel):
    id: str
    question: str
    inputMode: Literal["choice", "text", "choice_or_text"]
    options: list[AIHumanInputOptionDTO] = Field(default_factory=list)
    allowMultiple: bool = False
    required: bool = True
    reason: str | None = None
    sourceSkills: list[str] = Field(default_factory=list)
    resumeHint: dict = Field(default_factory=dict)


class AIHumanInputResponseDTO(BaseModel):
    selectedOptionIds: list[str] = Field(default_factory=list)
    text: str = ""
    summary: str = ""


class AIMessageImageDTO(BaseModel):
    media_id: str
    asset: MediaAssetOut
    alt: str = ""


class AIMessagePartDTO(BaseModel):
    id: str
    type: AIMessagePartType
    status: str | None = None
    responded_at: datetime | None = None
    text: str | None = None
    image: AIMessageImageDTO | None = None
    card: AIResultCardDTO | None = None
    draft: AITaskDraftDTO | None = None
    approval: AIApprovalRequestDTO | None = None
    request: AIHumanInputRequestDTO | None = None
    response: AIHumanInputResponseDTO | None = None
    activity: AIRunEventDTO | None = None


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


class AIQualityWindowDTO(BaseModel):
    limit: int
    days: int | None = None


class AIQualityTotalsDTO(BaseModel):
    skillExecutionCount: int = 0
    completedSkillExecutionCount: int = 0
    toolCallCount: int = 0
    draftCount: int = 0
    approvalRequestCount: int = 0
    clarificationCount: int = 0
    approvalApprovedCount: int = 0
    approvalRejectedCount: int = 0
    totalDurationMs: int = 0
    averageDurationMs: int = 0


class AIQualityRecentRunDTO(BaseModel):
    id: str
    agent_key: str
    intent: str
    status: str
    model: str = ""
    created_at: datetime
    duration_ms: int = 0
    error_code: str | None = None
    routing_skills: list[str] = Field(default_factory=list)
    clarification_count: int = 0
    approval_request_count: int = 0
    approval_approved_count: int = 0
    approval_rejected_count: int = 0


class AIQualityMetricsResponse(BaseModel):
    family_id: str
    window: AIQualityWindowDTO
    run_count: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    intent_counts: dict[str, int] = Field(default_factory=dict)
    routing_skill_counts: dict[str, int] = Field(default_factory=dict)
    clarification_reasons: dict[str, int] = Field(default_factory=dict)
    clarification_by_skill: dict[str, int] = Field(default_factory=dict)
    approval_by_draft_type: dict[str, dict[str, int]] = Field(default_factory=dict)
    skill_diagnostics: dict[str, int] = Field(default_factory=dict)
    skill_status_counts: dict[str, int] = Field(default_factory=dict)
    totals: AIQualityTotalsDTO
    recent_runs: list[AIQualityRecentRunDTO] = Field(default_factory=list)


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


class AIToolRegistryItemDTO(BaseModel):
    name: str
    display_name: str
    description: str
    permission: str
    side_effect: Literal["read", "draft", "write", "control"]
    requires_confirmation: bool
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict = Field(default_factory=dict)


class AISkillRegistryItemDTO(BaseModel):
    key: str
    name: str
    description: str
    runner: str = "markdown"
    examples: list[str] = Field(default_factory=list)
    context_policy: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    scripts: list[str] = Field(default_factory=list)
    output_types: list[str] = Field(default_factory=list)
    draft_types: list[str] = Field(default_factory=list)
    approval_policy: str
    intent: str
    agent_key: str


class AIRegistryResponse(BaseModel):
    skills: list[AISkillRegistryItemDTO] = Field(default_factory=list)
    tools: list[AIToolRegistryItemDTO] = Field(default_factory=list)


class AIApprovalDecisionRequest(BaseModel):
    decision: AIApprovalDecision
    draft_version: int
    values: dict = Field(default_factory=dict)
    comment: str | None = None


class AIHumanInputResponseRequest(BaseModel):
    selected_option_ids: list[str] = Field(default_factory=list, max_length=20)
    text: str | None = Field(default=None, max_length=2000)


class AIApprovalDecisionResponse(BaseModel):
    approval: AIApprovalRequestDTO
    draft: AITaskDraftDTO
    operation: dict | None = None
    business_entity: dict | None = None
