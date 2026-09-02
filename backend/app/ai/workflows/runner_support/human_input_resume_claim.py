from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import secrets
from typing import Any

from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.utils import utcnow
from app.models.domain import AIAgentRun


# A stream resume is executed by a worker with a different SQLAlchemy Session.
# Keep the claim in the durable Run JSON rather than in request-local state.  The
# key is intentionally internal and is never part of the public Run serializer.
STREAM_RESUME_CLAIM_CONTEXT_KEY = "_streamResumeClaim"
STREAM_RESUME_CLAIM_TOKEN_KEY = "_resumeClaimToken"
STREAM_RESUME_CLAIM_KIND = "human_input"
STREAM_APPROVAL_RESUME_CLAIM_KIND = "approval"
STREAM_RESUME_CLAIM_TTL = timedelta(hours=1)


@dataclass(frozen=True, slots=True)
class StreamResumeClaim:
    token: str
    request_id: str
    user_id: str
    run_id: str
    claimed_at: str
    payload_hash: str


def current_stream_resume_claim(run: AIAgentRun) -> dict[str, Any] | None:
    """Return the active durable stream claim, failing closed on malformed data."""

    summary = run.context_summary if isinstance(run.context_summary, dict) else {}
    if STREAM_RESUME_CLAIM_CONTEXT_KEY not in summary:
        return None
    value = summary.get(STREAM_RESUME_CLAIM_CONTEXT_KEY)
    if not isinstance(value, dict):
        return {}
    claimed_at = value.get("claimedAt")
    if isinstance(claimed_at, str) and _stream_resume_claim_expired(claimed_at):
        return None
    return dict(value)


def _stream_resume_claim_expired(claimed_at: str, *, now: datetime | None = None) -> bool:
    try:
        parsed = datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    reference = now or utcnow()
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=UTC)
    return reference - parsed.astimezone(UTC) >= STREAM_RESUME_CLAIM_TTL


def claim_stream_resume(
    db: Session,
    *,
    run: AIAgentRun,
    kind: str,
    request_id: str,
    user_id: str,
    payload_hash: str = "",
) -> StreamResumeClaim:
    """Persist and commit one stream-resume claim for an already locked Run.

    Callers must hold the Run row lock and have completed all read-only
    validation before invoking this function.  Committing here is deliberate:
    the worker has a separate Session and must only start after this claim is
    visible to it and the request transaction has released the row lock.
    """

    if current_stream_resume_claim(run) is not None:
        raise AIConflictError("这次恢复任务正在处理中，请稍后刷新")

    token = secrets.token_urlsafe(32)
    claimed_at = utcnow().isoformat()
    claim = StreamResumeClaim(
        token=token,
        request_id=str(request_id),
        user_id=str(user_id),
        run_id=run.id,
        claimed_at=claimed_at,
        payload_hash=str(payload_hash),
    )
    summary = dict(run.context_summary or {})
    summary[STREAM_RESUME_CLAIM_CONTEXT_KEY] = {
        "kind": str(kind),
        "token": claim.token,
        "requestId": claim.request_id,
        "userId": claim.user_id,
        "runId": claim.run_id,
        "claimedAt": claim.claimed_at,
        "payloadHash": claim.payload_hash,
    }
    run.context_summary = summary
    db.flush()
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    return claim


def claim_stream_human_input_resume(
    db: Session,
    *,
    run: AIAgentRun,
    request_id: str,
    user_id: str,
    payload_hash: str = "",
) -> StreamResumeClaim:
    return claim_stream_resume(
        db,
        run=run,
        kind=STREAM_RESUME_CLAIM_KIND,
        request_id=request_id,
        user_id=user_id,
        payload_hash=payload_hash,
    )


def stream_resume_claim_token(resume: Any) -> str | None:
    if not isinstance(resume, dict) or STREAM_RESUME_CLAIM_TOKEN_KEY not in resume:
        return None
    token = resume.get(STREAM_RESUME_CLAIM_TOKEN_KEY)
    return str(token).strip() if isinstance(token, str) else ""


def claim_matches_resume(
    run: AIAgentRun,
    *,
    token: str,
    request_id: str,
    user_id: str,
    payload_hash: str | None = None,
) -> bool:
    return claim_matches_stream_resume(
        run,
        token=token,
        kind=STREAM_RESUME_CLAIM_KIND,
        request_id=request_id,
        user_id=user_id,
        payload_hash=payload_hash,
    )


def claim_matches_stream_resume(
    run: AIAgentRun,
    *,
    token: str,
    kind: str,
    request_id: str,
    user_id: str,
    payload_hash: str | None = None,
) -> bool:
    claim = current_stream_resume_claim(run)
    if claim is None:
        return False
    return (
        claim.get("kind") == str(kind)
        and str(claim.get("token") or "") == token
        and str(claim.get("requestId") or "") == str(request_id)
        and str(claim.get("userId") or "") == str(user_id)
        and str(claim.get("runId") or "") == run.id
        and (payload_hash is None or str(claim.get("payloadHash") or "") == payload_hash)
    )


def clear_stream_resume_claim(run: AIAgentRun) -> None:
    summary = dict(run.context_summary or {})
    if STREAM_RESUME_CLAIM_CONTEXT_KEY not in summary:
        return
    summary.pop(STREAM_RESUME_CLAIM_CONTEXT_KEY, None)
    run.context_summary = summary
