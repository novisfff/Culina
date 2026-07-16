from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.schemas.meal_log_insights import MealInsightOut
from app.services.clock import today_for_family
from app.services.meal_log_insights import build_meal_log_insights

router = APIRouter(tags=["meal-logs"])


@router.get("/api/meal-logs/insights", response_model=list[MealInsightOut])
def get_meal_log_insights(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[MealInsightOut]:
    _, membership = auth
    today = today_for_family(membership.family_id, timezone_name="Asia/Shanghai")
    return build_meal_log_insights(
        db,
        family_id=membership.family_id,
        today=today,
    )
