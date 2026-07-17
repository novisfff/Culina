from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.core.enums import MealType
from app.core.utils import utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.repos.meal_log_candidates import list_meal_log_candidates, serialize_meal_log_candidates
from app.repos.meal_log_record_operations import MealRecordIdempotencyError
from app.schemas.meal_recording import (
    MealLogCandidateOut,
    MealLogRecordOperationSummaryOut,
    RecordMealRequest,
    RecordMealResponse,
    RevertMealRecordResponse,
)
from app.services.meal_log_record_history import (
    MealRecordHistoryError,
    MealRecordHistoryNotFoundError,
    MealRecordHistoryPermissionError,
    list_active_record_operations,
    revert_record_operation,
)
from app.services.food_plan_locking import FoodPlanConflict, food_plan_conflict_detail
from app.services.meal_log_references import MealLogReferenceError
from app.services.meal_log_versions import (
    MEAL_LOG_NOT_FOUND_CODE,
    MEAL_LOG_STALE_CODE,
    MEAL_LOG_STALE_RECOVERY_HINT,
    MealLogConflictError,
    build_meal_log_conflict_detail,
)
from app.services.meal_recording import (
    MealRecordValidationError,
    record_meal,
)

router = APIRouter(tags=["meal-log-recording"])


def _raise_meal_log_conflict(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str | None,
    exc: MealLogConflictError,
) -> None:
    if exc.code == MEAL_LOG_NOT_FOUND_CODE or meal_log_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal log not found") from exc
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=build_meal_log_conflict_detail(
            db,
            family_id=family_id,
            meal_log_id=meal_log_id,
            code=exc.code,
            recovery_hint=exc.recovery_hint,
            message=exc.message,
        ),
    ) from exc


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


@router.get(
    "/api/meal-logs/record-operations",
    response_model=list[MealLogRecordOperationSummaryOut],
)
def get_active_record_operations(
    active: bool = Query(...),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[MealLogRecordOperationSummaryOut]:
    if not active:
        return []
    user, membership = auth
    return list_active_record_operations(
        db,
        family_id=membership.family_id,
        actor_user_id=user.id,
        user_role=membership.role,
        now=utcnow(),
    )


@router.post(
    "/api/meal-logs/record-operations/{operation_id}/revert",
    response_model=RevertMealRecordResponse,
)
def post_revert_record_operation(
    operation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> RevertMealRecordResponse:
    user, membership = auth
    try:
        result = revert_record_operation(
            db,
            family_id=membership.family_id,
            actor_user_id=user.id,
            user_role=membership.role,
            operation_id=operation_id,
            now=utcnow(),
        )
        commit_session(db)
        return result
    except MealRecordHistoryNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except MealRecordHistoryPermissionError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except MealRecordHistoryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except Exception:
        db.rollback()
        raise


@router.post("/api/meal-logs/record", response_model=RecordMealResponse)
def post_record_meal(
    payload: RecordMealRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> RecordMealResponse:
    user, membership = auth
    meal_log_id_for_conflict: str | None = (
        payload.target.meal_log_id if payload.target.kind == "existing" else None
    )
    try:
        result = record_meal(
            db,
            family_id=membership.family_id,
            actor_user_id=user.id,
            request=payload,
            now=utcnow(),
        )
        commit_session(db)
        return result
    except MealRecordIdempotencyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": exc.code,
                "message": exc.message,
                "current": None,
                "recovery_hint": "use_new_request_id",
            },
        ) from exc
    except MealRecordValidationError as exc:
        db.rollback()
        if exc.code == "meal_log_food_not_found":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": exc.code, "message": exc.message},
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except FoodPlanConflict as exc:
        db.rollback()
        status_code = (
            status.HTTP_404_NOT_FOUND
            if exc.code == "food_plan_item_not_found"
            else status.HTTP_409_CONFLICT
        )
        raise HTTPException(
            status_code=status_code,
            detail=food_plan_conflict_detail(exc),
        ) from exc
    except MealLogReferenceError as exc:
        db.rollback()
        status_code = (
            status.HTTP_404_NOT_FOUND
            if exc.code in {"meal_log_food_not_found", "meal_log_participant_not_found"}
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        raise HTTPException(
            status_code=status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except MealLogConflictError as exc:
        db.rollback()
        _raise_meal_log_conflict(
            db,
            family_id=membership.family_id,
            meal_log_id=meal_log_id_for_conflict,
            exc=exc,
        )
    except StaleDataError as exc:
        db.rollback()
        if meal_log_id_for_conflict is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": MEAL_LOG_STALE_CODE,
                    "message": "这顿饭刚被家人更新，请刷新后确认",
                    "current": None,
                    "recovery_hint": MEAL_LOG_STALE_RECOVERY_HINT,
                },
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=build_meal_log_conflict_detail(
                db,
                family_id=membership.family_id,
                meal_log_id=meal_log_id_for_conflict,
                code=MEAL_LOG_STALE_CODE,
                recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
            ),
        ) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
