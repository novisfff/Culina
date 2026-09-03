from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.ai.errors import AIConflictError
from app.ai.workflows.runner_support.human_input_resume_handler import HumanInputResumeHandler
from app.ai.workflows.runner_support.human_input_resume_preparer import HumanInputResumePreparer
from app.ai.workflows.runner_support.human_input_resume_claim import (
    STREAM_RESUME_CLAIM_TTL,
    current_stream_resume_claim,
)
from app.core.enums import AiMode, AIConversationVisibility, MembershipStatus, UserRole
from app.core.utils import utcnow
from app.models.domain import (
    AIAgentRun,
    AIConversation,
    AIMessage,
    Base,
    Family,
    Membership,
    User,
)
from app.services.ai_timeline import AITimelineService


PENDING_INPUT = {
    "id": "human-request-1",
    "question": "选择哪一个？",
    "inputMode": "choice",
    "options": [{"id": "option-1", "label": "第一个"}],
}


class _SnapshotGraph:
    def __init__(self, *, run_id: str, conversation_id: str) -> None:
        self.snapshot = SimpleNamespace(
            values={
                "run_id": run_id,
                "family_id": "family-resume-claim",
                "user_id": "user-resume-claim",
                "conversation_id": conversation_id,
                "pending_human_input": PENDING_INPUT,
            },
            next=("human_input_interrupt",),
        )

    def get_state(self, config: dict[str, Any]) -> Any:
        del config
        return self.snapshot


@dataclass(frozen=True)
class _ResumeContext:
    SessionLocal: sessionmaker[Session]
    graph: _SnapshotGraph
    run_id: str
    conversation_id: str

    def preparer(self, db: Session) -> HumanInputResumePreparer:
        def build_resume_payload(**kwargs: Any) -> dict[str, Any]:
            return {
                "requestId": kwargs["request_id"],
                "selectedOptionIds": kwargs["selected_option_ids"],
                "text": kwargs["text"] or "",
                "userId": kwargs["user_id"],
                "familyId": kwargs["family_id"],
            }

        return HumanInputResumePreparer(
            db=db,
            graph=self.graph,
            config_for_conversation=lambda conversation_id: {
                "configurable": {"thread_id": conversation_id},
            },
            build_resume_payload=build_resume_payload,
        )

    def prepare(self, db: Session, *, stream: bool = True) -> Any:
        return self.preparer(db).prepare(
            family_id="family-resume-claim",
            user_id="user-resume-claim",
            conversation_id=self.conversation_id,
            request_id="human-request-1",
            selected_option_ids=["option-1"],
            text=None,
            stream=stream,
        )


@pytest.fixture()
def resume_context() -> Iterator[_ResumeContext]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    family_id = "family-resume-claim"
    user_id = "user-resume-claim"
    conversation_id = "conversation-resume-claim"
    run_id = "run-resume-claim"
    pending_part = {
        "id": "part-human-request-1",
        "type": "human_input_request",
        "status": "pending",
        "request": PENDING_INPUT,
    }
    with SessionLocal() as db:
        family = Family(id=family_id, name="恢复抢占测试家庭", motto="", location="")
        user = User(
            id=user_id,
            username="resume-claim-user",
            display_name="恢复抢占用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id="membership-resume-claim",
            family_id=family_id,
            user_id=user_id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        conversation = AIConversation(
            id=conversation_id,
            family_id=family_id,
            owner_user_id=user_id,
            visibility=AIConversationVisibility.PRIVATE,
            mode=AiMode.RECOMMENDATION,
            prompt="请选择食物",
            response="请选择食物",
            context={"workspace": True, "taskState": {"pendingHumanInput": PENDING_INPUT}},
            title="恢复抢占",
            summary="",
            status="active",
            last_run_status="waiting_input",
            created_by=user_id,
        )
        run = AIAgentRun(
            id=run_id,
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=None,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="general_chat",
            input_summary="请选择食物",
            context_summary={"pendingHumanInput": PENDING_INPUT},
            output_summary="",
            status="waiting_input",
            model="test-model",
            input={},
            output={},
            tool_calls=[],
            created_by=user_id,
        )
        message = AIMessage(
            id="message-resume-claim",
            family_id=family_id,
            conversation_id=conversation_id,
            role="assistant",
            content="请选择食物",
            content_type="parts",
            parts=[pending_part],
            run_id=run_id,
            status="waiting_input",
            message_metadata={},
            created_by=user_id,
        )
        db.add_all([family, user, membership, conversation])
        db.flush()
        db.add(run)
        db.flush()
        db.add(message)
        db.flush()
        run.message_id = message.id
        db.commit()
    context = _ResumeContext(
        SessionLocal=SessionLocal,
        graph=_SnapshotGraph(run_id=run_id, conversation_id=conversation_id),
        run_id=run_id,
        conversation_id=conversation_id,
    )
    try:
        yield context
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def _state(context: _ResumeContext) -> dict[str, Any]:
    return {
        "family_id": "family-resume-claim",
        "user_id": "user-resume-claim",
        "conversation_id": context.conversation_id,
        "run_id": context.run_id,
        "assistant_message_id": "message-resume-claim",
    }


def _runner(db: Session) -> Any:
    return SimpleNamespace(
        db=db,
        timeline_service=AITimelineService(db),
        _json_record=lambda value: value,
    )


def test_stream_prepare_commits_a_durable_claim_before_worker_handoff(
    resume_context: _ResumeContext,
) -> None:
    with resume_context.SessionLocal() as request_db:
        prepared = resume_context.prepare(request_db)
        claim_token = prepared.resume_payload.get("_resumeClaimToken")
        assert isinstance(claim_token, str) and claim_token

    with resume_context.SessionLocal() as worker_db:
        run = worker_db.get(AIAgentRun, resume_context.run_id)
        assert run is not None
        claim = (run.context_summary or {}).get("_streamResumeClaim")
        assert isinstance(claim, dict)
        assert claim.get("token") == claim_token


def test_second_stream_prepare_cannot_take_the_committed_claim(
    resume_context: _ResumeContext,
) -> None:
    with resume_context.SessionLocal() as first_db:
        resume_context.prepare(first_db)

    with resume_context.SessionLocal() as second_db:
        with pytest.raises(AIConflictError):
            resume_context.prepare(second_db)


def test_expired_stream_claim_can_be_replaced_after_worker_crash(
    resume_context: _ResumeContext,
) -> None:
    with resume_context.SessionLocal() as first_db:
        prepared = resume_context.prepare(first_db)
        run = first_db.get(AIAgentRun, resume_context.run_id)
        assert run is not None
        claim = dict((run.context_summary or {}).get("_streamResumeClaim") or {})
        claim["claimedAt"] = (utcnow() - STREAM_RESUME_CLAIM_TTL - timedelta(seconds=1)).isoformat()
        run.context_summary = {**(run.context_summary or {}), "_streamResumeClaim": claim}
        first_db.commit()

    with resume_context.SessionLocal() as second_db:
        replacement = resume_context.prepare(second_db)
        assert replacement.resume_payload.get("_resumeClaimToken")
        assert replacement.resume_payload.get("_resumeClaimToken") != claim.get("token")


def test_fresh_stream_claim_remains_active(resume_context: _ResumeContext) -> None:
    with resume_context.SessionLocal() as db:
        resume_context.prepare(db)
        run = db.get(AIAgentRun, resume_context.run_id)
        assert run is not None
        assert current_stream_resume_claim(run) is not None


def test_worker_must_present_the_committed_claim_token(
    resume_context: _ResumeContext,
) -> None:
    with resume_context.SessionLocal() as request_db:
        prepared = resume_context.prepare(request_db)

    bad_payload = {
        **prepared.resume_payload,
        "_resumeClaimToken": "wrong-token",
    }
    runner = None
    with resume_context.SessionLocal() as worker_db:
        runner = _runner(worker_db)
        handler = HumanInputResumeHandler(runner)
        with pytest.raises(AIConflictError):
            handler.resume(
                state=_state(resume_context),
                pending=PENDING_INPUT,
                resume=bad_payload,
                run_artifacts=[],
            )
        worker_db.rollback()

    assert runner is not None


def test_worker_consumes_claim_and_records_answer_once(
    resume_context: _ResumeContext,
) -> None:
    with resume_context.SessionLocal() as request_db:
        prepared = resume_context.prepare(request_db)

    with resume_context.SessionLocal() as worker_db:
        runner = _runner(worker_db)
        patch = HumanInputResumeHandler(runner).resume(
            state=_state(resume_context),
            pending=PENDING_INPUT,
            resume=prepared.resume_payload,
            run_artifacts=[],
        )
        assert patch["status"] == "running"
        worker_db.commit()

    with resume_context.SessionLocal() as verify_db:
        run = verify_db.get(AIAgentRun, resume_context.run_id)
        message = verify_db.get(AIMessage, "message-resume-claim")
        assert run is not None
        assert message is not None
        assert "_streamResumeClaim" not in (run.context_summary or {})
        matching_parts = [
            part
            for part in message.parts or []
            if isinstance(part, dict)
            and part.get("type") == "human_input_request"
            and (part.get("request") or {}).get("id") == PENDING_INPUT["id"]
        ]
        assert len(matching_parts) == 1
        assert matching_parts[0]["status"] == "completed"
        assert matching_parts[0]["response"]["selectedOptionIds"] == ["option-1"]

    with resume_context.SessionLocal() as replay_db:
        runner = SimpleNamespace(db=replay_db, _json_record=lambda value: value)
        with pytest.raises(AIConflictError):
            HumanInputResumeHandler(runner).resume(
                state=_state(resume_context),
                pending=PENDING_INPUT,
                resume=prepared.resume_payload,
                run_artifacts=[],
            )
        replay_db.rollback()
