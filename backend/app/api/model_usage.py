from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.deps import get_current_auth, require_owner
from app.core.enums import ActivityAction
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.model_usage import (
    ModelUsageAlertOut,
    ModelUsageAlertReceiptOut,
    ModelUsageFamilyBreakdownOut,
    ModelUsageFamilyOverviewOut,
    ModelUsagePolicyOut,
    ModelUsagePolicyUpdateRequest,
    ModelUsagePersonalBreakdownOut,
    ModelUsagePersonalOverviewOut,
)
from app.models.model_usage import ModelUsageAlert, ModelUsageAlertReceipt
from app.services.model_usage.queries import (
    get_family_usage_breakdown,
    get_family_usage_overview,
    get_personal_usage_breakdown,
    get_personal_usage_overview,
)
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.errors import (
    ModelUsagePolicyConflict,
    ModelUsagePolicyValidationError,
)
from app.services.model_usage.policies import (
    CapabilityLimitCommand,
    PolicyUpdateCommand,
    current_policy,
    update_family_policy,
)
from app.services.model_usage.pricing import price_coverage
from app.services.model_usage.serializers import (
    serialize_family_overview,
    serialize_alert,
    serialize_alert_receipt,
    serialize_personal_overview,
    serialize_policy,
    serialize_usage_breakdown,
)
from app.services.model_usage.subjects import ensure_user_subject
from app.services.activity import log_activity
from app.core.utils import utcnow


router = APIRouter(tags=["model-usage"])


def _query_error(exc: ValueError | LookupError) -> HTTPException:
    code = str(exc)
    if code in {
        "model_usage_invalid_period",
        "model_usage_future_period_not_allowed",
        "model_usage_invalid_group_by",
    }:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": code},
        )
    if code in {
        "model_usage_historical_rollup_not_found",
        "model_usage_subject_not_found",
    }:
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": code})
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "model_usage_query_unavailable"},
    )


def _policy_command(
    *,
    family_id: str,
    actor_subject_id: str,
    payload: ModelUsagePolicyUpdateRequest,
    active_variants: tuple,
) -> PolicyUpdateCommand:
    return PolicyUpdateCommand(
        family_id=family_id,
        base_version_number=payload.base_version_number,
        monthly_budget_cny=payload.monthly_budget_cny,
        alerts_enabled=payload.alerts_enabled,
        hard_limit_enabled=payload.hard_limit_enabled,
        capability_limits=tuple(
            CapabilityLimitCommand(
                capability=limit.capability,
                limit_kind=limit.limit_kind,
                meter=limit.meter,
                limit_value=limit.limit_value,
                enabled=limit.enabled,
            )
            for limit in payload.capability_limits
        ),
        actor_subject_id=actor_subject_id,
        active_variants=active_variants,
    )


def _require_missing_price_confirmation(
    db: Session,
    *,
    payload: ModelUsagePolicyUpdateRequest,
    current,
    active_variants: tuple,
) -> None:
    if (
        current.hard_limit_enabled
        or not payload.hard_limit_enabled
        or not active_variants
        or payload.confirm_missing_price_impact
    ):
        return
    coverage = price_coverage(db, configured_variants=active_variants, at=utcnow())
    if not coverage.healthy:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "model_usage_missing_price_confirmation_required"},
        )


@router.get(
    "/api/model-usage/me/overview",
    response_model=ModelUsagePersonalOverviewOut,
    response_model_exclude_none=True,
)
def personal_overview(
    period: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    try:
        overview = get_personal_usage_overview(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            period=period,
        )
    except (ValueError, LookupError) as exc:
        raise _query_error(exc) from exc
    return serialize_personal_overview(overview)


@router.get(
    "/api/model-usage/me/breakdown",
    response_model=ModelUsagePersonalBreakdownOut,
    response_model_exclude_none=True,
)
def personal_breakdown(
    period: str,
    group_by: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    try:
        breakdown = get_personal_usage_breakdown(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            period=period,
            group_by=group_by,
        )
    except (ValueError, LookupError) as exc:
        raise _query_error(exc) from exc
    return serialize_usage_breakdown(breakdown)


@router.get(
    "/api/model-usage/family/overview",
    response_model=ModelUsageFamilyOverviewOut,
    response_model_exclude_none=True,
)
def family_overview(
    period: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _, membership = auth
    try:
        overview = get_family_usage_overview(
            db,
            family_id=membership.family_id,
            period=period,
        )
    except (ValueError, LookupError) as exc:
        raise _query_error(exc) from exc
    return serialize_family_overview(overview)


@router.get(
    "/api/model-usage/family/breakdown",
    response_model=ModelUsageFamilyBreakdownOut,
    response_model_exclude_none=True,
)
def family_breakdown(
    period: str,
    group_by: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _, membership = auth
    try:
        breakdown = get_family_usage_breakdown(
            db,
            family_id=membership.family_id,
            period=period,
            group_by=group_by,
        )
    except (ValueError, LookupError) as exc:
        raise _query_error(exc) from exc
    return serialize_usage_breakdown(breakdown)


@router.get(
    "/api/model-usage/family/policy",
    response_model=ModelUsagePolicyOut,
)
def get_family_policy(
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _, membership = auth
    try:
        policy = current_policy(db, family_id=membership.family_id)
    except ValueError as exc:
        raise _query_error(exc) from exc
    return serialize_policy(db, policy)


@router.put(
    "/api/model-usage/family/policy",
    response_model=ModelUsagePolicyOut,
)
def update_policy(
    payload: ModelUsagePolicyUpdateRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    current = current_policy(db, family_id=membership.family_id)
    active_variants = configured_usage_variants(get_settings())
    _require_missing_price_confirmation(
        db,
        payload=payload,
        current=current,
        active_variants=active_variants,
    )
    actor_subject = ensure_user_subject(
        db,
        family_id=membership.family_id,
        user_id=user.id,
    )
    try:
        policy = update_family_policy(
            db,
            _policy_command(
                family_id=membership.family_id,
                actor_subject_id=actor_subject.id,
                payload=payload,
                active_variants=active_variants,
            ),
        )
    except ModelUsagePolicyConflict as exc:
        current_policy_payload = jsonable_encoder(
            serialize_policy(db, exc.current_policy)
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "model_usage_policy_conflict",
                "current_policy": current_policy_payload,
                "current_version_number": exc.current_policy.version_number,
                "recovery_hint": "review_current_policy_and_reapply",
            },
        ) from exc
    except ModelUsagePolicyValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": str(exc)},
        ) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="ModelUsagePolicy",
        entity_id=policy.id,
        summary="更新了模型预算设置",
    )
    commit_session(db)
    return serialize_policy(db, policy)


def _owner_alert_receipt_for_update(
    db: Session,
    *,
    family_id: str,
    owner_user_id: str,
    alert_id: str,
) -> ModelUsageAlertReceipt:
    receipt = db.scalar(
        select(ModelUsageAlertReceipt)
        .join(ModelUsageAlert, ModelUsageAlert.id == ModelUsageAlertReceipt.alert_id)
        .where(
            ModelUsageAlert.id == alert_id,
            ModelUsageAlert.family_id == family_id,
            ModelUsageAlertReceipt.user_id == owner_user_id,
        )
        .with_for_update()
    )
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "model_usage_alert_not_found"},
        )
    return receipt


@router.get(
    "/api/model-usage/alerts",
    response_model=list[ModelUsageAlertOut],
)
def list_alerts(
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    user, membership = auth
    rows = db.execute(
        select(ModelUsageAlert, ModelUsageAlertReceipt)
        .join(ModelUsageAlertReceipt, ModelUsageAlertReceipt.alert_id == ModelUsageAlert.id)
        .where(
            ModelUsageAlert.family_id == membership.family_id,
            ModelUsageAlertReceipt.user_id == user.id,
            ModelUsageAlertReceipt.dismissed_at.is_(None),
        )
        .order_by(ModelUsageAlert.created_at.desc(), ModelUsageAlert.id.desc())
    ).all()
    return [serialize_alert(alert, receipt) for alert, receipt in rows]


@router.post(
    "/api/model-usage/alerts/{alert_id}/seen",
    response_model=ModelUsageAlertReceiptOut,
)
def mark_alert_seen(
    alert_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    receipt = _owner_alert_receipt_for_update(
        db,
        family_id=membership.family_id,
        owner_user_id=user.id,
        alert_id=alert_id,
    )
    receipt.seen_at = receipt.seen_at or utcnow()
    commit_session(db)
    return serialize_alert_receipt(receipt)


@router.post(
    "/api/model-usage/alerts/{alert_id}/dismiss",
    response_model=ModelUsageAlertReceiptOut,
)
def dismiss_alert(
    alert_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    receipt = _owner_alert_receipt_for_update(
        db,
        family_id=membership.family_id,
        owner_user_id=user.id,
        alert_id=alert_id,
    )
    receipt.dismissed_at = receipt.dismissed_at or utcnow()
    commit_session(db)
    return serialize_alert_receipt(receipt)
