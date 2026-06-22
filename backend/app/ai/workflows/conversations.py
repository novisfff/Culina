from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import AiMode
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage, Food, Ingredient, Recipe


ACTIVE_CONVERSATION_RUN_STATUSES = {"pending", "running", "waiting_input"}


def normalize_workspace_subject(db: Session, *, family_id: str, subject: dict[str, Any] | None) -> dict[str, Any]:
    value = dict(subject or {})
    recipe_id = value.get("recipe_id") or value.get("recipeId")
    food_id = value.get("food_id") or value.get("foodId")
    ingredient_ids = value.get("ingredient_ids") or value.get("ingredientIds") or []

    if recipe_id:
        matched_recipe_id = db.scalar(select(Recipe.id).where(Recipe.id == str(recipe_id), Recipe.family_id == family_id))
        if matched_recipe_id is None:
            raise ValueError("引用的菜谱不属于当前家庭或不存在")
        value["recipe_id"] = str(recipe_id)
    if food_id:
        matched_food_id = db.scalar(select(Food.id).where(Food.id == str(food_id), Food.family_id == family_id))
        if matched_food_id is None:
            raise ValueError("引用的食物不属于当前家庭或不存在")
        value["food_id"] = str(food_id)
    if not isinstance(ingredient_ids, list):
        raise ValueError("引用的食材列表格式不正确")
    normalized_ingredient_ids = list(dict.fromkeys(str(item) for item in ingredient_ids if str(item)))
    if normalized_ingredient_ids:
        matched_ids = set(
            db.scalars(
                select(Ingredient.id).where(
                    Ingredient.family_id == family_id,
                    Ingredient.id.in_(normalized_ingredient_ids),
                )
            )
        )
        if matched_ids != set(normalized_ingredient_ids):
            raise ValueError("引用的食材不属于当前家庭或不存在")
        value["ingredient_ids"] = normalized_ingredient_ids
    return value


def find_idempotent_run(
    db: Session,
    *,
    family_id: str,
    client_message_id: str | None,
    client_run_id: str | None,
) -> AIAgentRun | None:
    candidates: list[AIAgentRun] = []
    if client_run_id:
        run = db.get(AIAgentRun, client_run_id)
        if run is not None:
            if run.family_id != family_id:
                raise AIConflictError("运行标识已被占用")
            candidates.append(run)
    if client_message_id:
        message = db.scalar(
            select(AIMessage).where(
                AIMessage.family_id == family_id,
                AIMessage.role == "user",
                AIMessage.client_message_id == client_message_id,
            )
        )
        if message is not None:
            run = db.scalar(
                select(AIAgentRun).where(
                    AIAgentRun.family_id == family_id,
                    AIAgentRun.message_id == message.id,
                )
            )
            if run is not None:
                candidates.append(run)
    if not candidates:
        return None
    if len({item.id for item in candidates}) != 1:
        raise AIConflictError("消息标识与运行标识指向不同任务")
    return candidates[0]


def find_active_conversation_run(db: Session, *, family_id: str, conversation_id: str) -> AIAgentRun | None:
    return db.scalar(
        select(AIAgentRun)
        .where(
            AIAgentRun.family_id == family_id,
            AIAgentRun.conversation_id == conversation_id,
            AIAgentRun.status.in_(ACTIVE_CONVERSATION_RUN_STATUSES),
        )
        .order_by(AIAgentRun.created_at.asc(), AIAgentRun.id.asc())
    )


def get_or_create_conversation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str | None,
    prompt: str,
    quick_task: str | None,
) -> AIConversation:
    if conversation_id:
        conversation = db.scalar(
            select(AIConversation)
            .where(AIConversation.id == conversation_id, AIConversation.family_id == family_id)
            .with_for_update()
        )
        if conversation is None:
            raise LookupError("会话不存在")
        return conversation
    title = "今日吃什么" if quick_task == "today_recommendation" else prompt[:24]
    conversation = AIConversation(
        id=create_id("conversation"),
        family_id=family_id,
        mode=AiMode.RECOMMENDATION,
        prompt=prompt,
        response="",
        context={"workspace": True},
        title=title,
        summary="",
        status="active",
        last_message_at=utcnow(),
        created_by=user_id,
    )
    db.add(conversation)
    db.flush()
    return conversation


def require_conversation(db: Session, *, family_id: str, conversation_id: str) -> AIConversation:
    conversation = db.scalar(select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == family_id))
    if conversation is None:
        raise LookupError("会话不存在")
    return conversation


def resolve_conversation_user_id(db: Session, conversation_id: str) -> str | None:
    conversation = db.get(AIConversation, conversation_id)
    if conversation is None:
        return None
    return conversation.created_by
