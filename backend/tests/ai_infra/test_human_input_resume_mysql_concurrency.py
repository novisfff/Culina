from __future__ import annotations

import os
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.ai.errors import AIConflictError
from app.ai.workflows.runner_support.approval_resume_preparer import ApprovalResumePreparer
from app.ai.workflows.runner_support.human_input_resume_handler import HumanInputResumeHandler
from app.ai.workflows.runner_support.human_input_resume_preparer import HumanInputResumePreparer
from app.core.enums import AiMode, AIConversationVisibility, MembershipStatus, UserRole
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AITaskDraft,
    Base,
    Family,
    Membership,
    User,
)
from app.services.ai_timeline import AITimelineService


FAMILY_ID = "family-human-input-mysql"
USER_ID = "user-human-input-mysql"
CONVERSATION_ID = "conversation-human-input-mysql"
RUN_ID = "run-human-input-mysql"
REQUEST_ID = "human-request-mysql"
APPROVAL_ID = "approval-request-mysql"
PENDING_INPUT = {
    "id": REQUEST_ID,
    "question": "选择哪一个？",
    "inputMode": "choice",
    "options": [{"id": "option-1", "label": "第一个"}],
}


def _mysql_url() -> str:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    if not (make_url(value).database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return value


class _SnapshotGraph:
    def __init__(self, *, next_node: str = "human_input_interrupt") -> None:
        self.next_node = next_node

    def get_state(self, config: dict[str, Any]) -> Any:
        del config
        return SimpleNamespace(
            values={
                "run_id": RUN_ID,
                "family_id": FAMILY_ID,
                "user_id": USER_ID,
                "conversation_id": CONVERSATION_ID,
                "pending_human_input": PENDING_INPUT,
            },
            next=(self.next_node,),
        )


@dataclass(frozen=True, slots=True)
class _MysqlResumeContext:
    SessionLocal: sessionmaker[Session]
    graph: _SnapshotGraph

    def prepare(self, db: Session, *, stream: bool = True) -> Any:
        preparer = HumanInputResumePreparer(
            db=db,
            graph=self.graph,
            config_for_conversation=lambda conversation_id: {
                "configurable": {"thread_id": conversation_id},
            },
            build_resume_payload=self._build_resume_payload,
        )
        return preparer.prepare(
            family_id=FAMILY_ID,
            user_id=USER_ID,
            conversation_id=CONVERSATION_ID,
            request_id=REQUEST_ID,
            selected_option_ids=["option-1"],
            text=None,
            stream=stream,
        )

    @staticmethod
    def _build_resume_payload(**kwargs: Any) -> dict[str, Any]:
        return {
            "requestId": kwargs["request_id"],
            "selectedOptionIds": kwargs["selected_option_ids"],
            "text": kwargs["text"] or "",
            "userId": kwargs["user_id"],
            "familyId": kwargs["family_id"],
        }


@pytest.fixture()
def mysql_resume_context() -> Iterator[_MysqlResumeContext]:
    engine = create_engine(
        _mysql_url(),
        poolclass=NullPool,
        pool_pre_ping=True,
        future=True,
    )
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    with SessionLocal() as db:
        family = Family(id=FAMILY_ID, name="MySQL 恢复抢占家庭", motto="", location="")
        user = User(
            id=USER_ID,
            username="human-input-mysql-user",
            display_name="MySQL 恢复用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id="membership-human-input-mysql",
            family_id=FAMILY_ID,
            user_id=USER_ID,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        conversation = AIConversation(
            id=CONVERSATION_ID,
            family_id=FAMILY_ID,
            owner_user_id=USER_ID,
            visibility=AIConversationVisibility.PRIVATE,
            mode=AiMode.RECOMMENDATION,
            prompt="请选择食物",
            response="请选择食物",
            context={"workspace": True, "taskState": {"pendingHumanInput": PENDING_INPUT}},
            title="恢复抢占",
            summary="",
            status="active",
            last_run_status="waiting_input",
            created_by=USER_ID,
        )
        run = AIAgentRun(
            id=RUN_ID,
            family_id=FAMILY_ID,
            conversation_id=CONVERSATION_ID,
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
            created_by=USER_ID,
        )
        message = AIMessage(
            id="message-human-input-mysql",
            family_id=FAMILY_ID,
            conversation_id=CONVERSATION_ID,
            role="assistant",
            content="请选择食物",
            content_type="parts",
            parts=[
                {
                    "id": "part-human-input-mysql",
                    "type": "human_input_request",
                    "status": "pending",
                    "request": PENDING_INPUT,
                }
            ],
            run_id=RUN_ID,
            status="waiting_input",
            message_metadata={},
            created_by=USER_ID,
        )
        db.add_all([family, user, membership, conversation])
        db.flush()
        db.add(run)
        db.flush()
        db.add(message)
        db.flush()
        run.message_id = message.id
        db.commit()
    context = _MysqlResumeContext(SessionLocal=SessionLocal, graph=_SnapshotGraph())
    try:
        yield context
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def _short_lock_timeout(db: Session) -> None:
    db.execute(text("SET SESSION innodb_lock_wait_timeout = 2"))


def _prepare_approval_resume(db: Session) -> Any:
    preparer = ApprovalResumePreparer(
        db=db,
        graph=_SnapshotGraph(next_node="approval_interrupt"),
        config_for_conversation=lambda conversation_id: {
            "configurable": {"thread_id": conversation_id},
        },
        build_resume_payload=lambda **kwargs: {
            "approvalId": kwargs["approval_id"],
            "decision": kwargs["decision"],
            "draftVersion": kwargs["draft_version"],
            "values": kwargs["values"],
            "comment": kwargs["comment"],
            "userId": kwargs["user_id"],
            "familyId": kwargs["family_id"],
        },
    )
    return preparer.prepare(
        family_id=FAMILY_ID,
        user_id=USER_ID,
        conversation_id=CONVERSATION_ID,
        approval_id=APPROVAL_ID,
        decision="rejected",
        draft_version=1,
        values={},
        comment="暂不执行",
        stream=True,
    )


def _make_pending_approval(db: Session) -> None:
    run = db.get(AIAgentRun, RUN_ID)
    conversation = db.get(AIConversation, CONVERSATION_ID)
    assert run is not None
    assert conversation is not None
    run.status = "waiting_approval"
    conversation.last_run_status = "waiting_approval"
    draft = AITaskDraft(
        id="draft-approval-mysql",
        family_id=FAMILY_ID,
        conversation_id=CONVERSATION_ID,
        source_run_id=RUN_ID,
        message_id="message-human-input-mysql",
        draft_type="food_profile",
        payload={},
        preview_summary="MySQL 审批恢复测试",
        status="pending_confirmation",
        version=1,
        schema_version="food_profile.v1",
        validation_errors=[],
        ai_metadata={},
        payload_hash="approval-mysql-payload-hash",
        idempotency_key="approval-mysql-idempotency-key",
        created_by=USER_ID,
        updated_by=USER_ID,
    )
    db.add(draft)
    db.flush()
    db.add(
        AIApprovalRequest(
            id=APPROVAL_ID,
            family_id=FAMILY_ID,
            conversation_id=CONVERSATION_ID,
            message_id="message-human-input-mysql",
            run_id=RUN_ID,
            draft_id="draft-approval-mysql",
            draft_version=1,
            draft_schema_version="food_profile.v1",
            approval_type="food_profile",
            status="pending",
            request_payload={},
            field_schema=[],
            initial_values={},
            submitted_values={},
            created_by=USER_ID,
            updated_by=USER_ID,
        )
    )
    db.commit()


def test_stream_prepare_releases_run_lock_before_worker_session_starts(
    mysql_resume_context: _MysqlResumeContext,
) -> None:
    # Keep the request transaction open while the worker session attempts the
    # lock.  The pre-fix implementation blocks here until MySQL returns 1205.
    with mysql_resume_context.SessionLocal() as request_db:
        prepared = mysql_resume_context.prepare(request_db, stream=True)
        claim_token = prepared.resume_payload.get("_resumeClaimToken")
        assert isinstance(claim_token, str) and claim_token

        with mysql_resume_context.SessionLocal() as worker_db:
            _short_lock_timeout(worker_db)
            locked_run = worker_db.scalar(
                select(AIAgentRun)
                .where(AIAgentRun.id == RUN_ID, AIAgentRun.family_id == FAMILY_ID)
                .with_for_update()
            )
            assert locked_run is not None
            claim = (locked_run.context_summary or {}).get("_streamResumeClaim")
            assert isinstance(claim, dict)
            assert claim.get("token") == claim_token
            worker_db.rollback()


def test_approval_stream_prepare_releases_run_lock_before_worker_session_starts(
    mysql_resume_context: _MysqlResumeContext,
) -> None:
    with mysql_resume_context.SessionLocal() as setup_db:
        _make_pending_approval(setup_db)

    with mysql_resume_context.SessionLocal() as request_db:
        prepared = _prepare_approval_resume(request_db)
        claim_token = prepared.resume_payload.get("_resumeClaimToken")
        assert isinstance(claim_token, str) and claim_token

        with mysql_resume_context.SessionLocal() as worker_db:
            _short_lock_timeout(worker_db)
            locked_run = worker_db.scalar(
                select(AIAgentRun)
                .where(AIAgentRun.id == RUN_ID, AIAgentRun.family_id == FAMILY_ID)
                .with_for_update()
            )
            assert locked_run is not None
            claim = (locked_run.context_summary or {}).get("_streamResumeClaim")
            assert isinstance(claim, dict)
            assert claim.get("kind") == "approval"
            assert claim.get("token") == claim_token
            worker_db.rollback()


def test_second_mysql_stream_resume_cannot_claim_the_same_run(
    mysql_resume_context: _MysqlResumeContext,
) -> None:
    with mysql_resume_context.SessionLocal() as first_db:
        first = mysql_resume_context.prepare(first_db, stream=True)
        assert first.resume_payload.get("_resumeClaimToken")

    with mysql_resume_context.SessionLocal() as second_db:
        _short_lock_timeout(second_db)
        with pytest.raises(AIConflictError):
            mysql_resume_context.prepare(second_db, stream=True)
        second_db.rollback()


def test_mysql_worker_consumes_claim_and_clears_it(
    mysql_resume_context: _MysqlResumeContext,
) -> None:
    with mysql_resume_context.SessionLocal() as request_db:
        prepared = mysql_resume_context.prepare(request_db, stream=True)

    with mysql_resume_context.SessionLocal() as worker_db:
        runner = SimpleNamespace(
            db=worker_db,
            timeline_service=AITimelineService(worker_db),
            _json_record=lambda value: value,
        )
        patch = HumanInputResumeHandler(runner).resume(
            state={
                "family_id": FAMILY_ID,
                "user_id": USER_ID,
                "conversation_id": CONVERSATION_ID,
                "run_id": RUN_ID,
                "assistant_message_id": "message-human-input-mysql",
            },
            pending=PENDING_INPUT,
            resume=prepared.resume_payload,
            run_artifacts=[],
        )
        assert patch["status"] == "running"
        worker_db.commit()

    with mysql_resume_context.SessionLocal() as verify_db:
        run = verify_db.get(AIAgentRun, RUN_ID)
        assert run is not None
        assert "_streamResumeClaim" not in (run.context_summary or {})
        assert run.status == "running"
