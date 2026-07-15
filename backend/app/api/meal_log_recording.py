from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.enums import MealType
from app.db.session import get_db
from app.repos.meal_log_candidates import list_meal_log_candidates, serialize_meal_log_candidates
from app.schemas.meal_recording import MealLogCandidateOut

router = APIRouter(tags=["meal-log-recording"])


@router.get("/api/meal-logs/candidates", response_model=list[MealLogCandidateOut])
def get_meal_log_candidates(
    date: date = Query(...),
    meal_type: MealType = Query(...),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    meal_logs = list_meal_log_candidates(
        db,
        family_id=membership.family_id,
        meal_date=date,
        meal_type=meal_type,
    )
    return serialize_meal_log_candidates(
        db,
        family_id=membership.family_id,
        meal_logs=meal_logs,
    )
