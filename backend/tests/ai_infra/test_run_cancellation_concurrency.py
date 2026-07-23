from __future__ import annotations

from threading import Event, Thread

from app.models.domain import AIRunCancelRequest

from ._support import *

from app.services.ai_operations.run_cancellation import (
    apply_run_cancellation_request,
    record_run_cancellation_request,
)


class FollowupCountingProvider(FakeChatProvider):
    def __init__(self) -> None:
        super().__init__()
        self.followup_calls = 0

    def stream_generate(self, **kwargs):
        del kwargs
        self.followup_calls += 1
        yield "审批后的继续回复"


class HumanInputRaceProvider(BaseChatProvider):
    model_name = "human-input-cancellation-race"

    def __init__(self) -> None:
        self.calls = 0
        self.followup_calls = 0

    def generate(self, **kwargs) -> ChatProviderResult:
        del kwargs
        raise AssertionError("orchestrator should use generate_with_tools")

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, user, tools, max_rounds
        self.calls += 1
        if self.calls == 1:
            tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排晚餐"})
            tool_handler(
                "human.request_input",
                {
                    "question": "要安排几天？",
                    "inputMode": "choice",
                    "options": [{"id": "three-days", "label": "三天"}],
                    "sourceSkills": ["meal_plan"],
                    "resumeHint": {"expectedField": "days"},
                },
            )
            text = "请先选择要安排的天数。"
        else:
            self.followup_calls += 1
            text = "已按三天继续安排。"
        if message_handler is not None:
            message_handler(text)
        return ChatProviderResult(text=text, status="completed", model=self.model_name)


class AIRunCancellationConcurrencyTestCase(AIAgentInfraTestCase):
    def _create_food_profile_approval(self, *, suffix: str) -> dict:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": f"新增食物 并发酸奶{suffix} 食物资料"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["status"], "waiting_approval")
        self.assertEqual(data["included"]["drafts"][0]["draft_type"], "food_profile")
        return data

    @staticmethod
    def _approval_payload(data: dict) -> dict:
        approval = data["included"]["approvals"][0]
        return {
            "decision": "approved",
            "draft_version": approval["draft_version"],
            "values": approval["initial_values"],
        }

    def _counts(self, *, run_id: str) -> tuple[int, int, int]:
        with self.SessionLocal() as db:
            operation_count = db.scalar(
                select(func.count(AIOperation.id)).where(AIOperation.approval_request_id.is_not(None))
            )
            food_count = db.scalar(select(func.count(Food.id)).where(Food.family_id == self.family.id))
            cancel_count = db.scalar(
                select(func.count(AIRunCancelRequest.id)).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == run_id,
                )
            )
        return int(operation_count or 0), int(food_count or 0), int(cancel_count or 0)

    def _create_waiting_human_input(self, provider: HumanInputRaceProvider) -> tuple[dict, str]:
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post("/api/ai/chat", json={"message": "帮我安排晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["status"], "waiting_input")
        human_part = next(
            part
            for part in data["message"]["parts"]
            if part.get("type") == "human_input_request"
        )
        return data, str(human_part["request"]["id"])

    def _human_result_artifact_count(self, *, message_id: str) -> int:
        with self.SessionLocal() as db:
            message = db.get(AIMessage, message_id)
            self.assertIsNotNone(message)
            assert message is not None
            artifacts = (message.message_metadata or {}).get("artifacts") or []
        return sum(
            1
            for artifact in artifacts
            if isinstance(artifact, dict) and artifact.get("type") == "human.input_result"
        )

    def test_cancel_wins_before_approval_business_write(self) -> None:
        data = self._create_food_profile_approval(suffix="取消先到")
        approval = data["included"]["approvals"][0]
        before_operation_count, before_food_count, _ = self._counts(run_id=data["run"]["id"])
        cancel_applied = Event()
        decision_done = Event()
        result: dict[str, object] = {}

        def submit_approval() -> None:
            self.assertTrue(cancel_applied.wait(timeout=5))
            response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json=self._approval_payload(data),
            )
            result["status_code"] = response.status_code
            decision_done.set()

        worker = Thread(target=submit_approval)
        worker.start()
        cancel_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/cancel")
        self.assertEqual(cancel_response.status_code, 200, cancel_response.text)
        cancel_applied.set()
        self.assertTrue(decision_done.wait(timeout=5))
        worker.join(timeout=5)

        after_operation_count, after_food_count, cancel_count = self._counts(run_id=data["run"]["id"])
        self.assertEqual(result["status_code"], 409)
        self.assertEqual(after_operation_count, before_operation_count)
        self.assertEqual(after_food_count, before_food_count)
        self.assertEqual(cancel_count, 1)

    def test_approval_business_write_commits_once_then_cancel_stops_continuation(self) -> None:
        provider = FollowupCountingProvider()
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            data = self._create_food_profile_approval(suffix="审批先到")
            approval = data["included"]["approvals"][0]
            before_operation_count, before_food_count, _ = self._counts(run_id=data["run"]["id"])
            business_written = Event()
            release_write = Event()
            response_done = Event()
            response_body: dict[str, object] = {}

            from app.services.ai_operations import approval_decisions

            original_execute = approval_decisions.execute_ai_operation_draft

            def blocking_execute(db, **kwargs):
                business_entity, entity_ids = original_execute(db, **kwargs)
                business_written.set()
                self.assertTrue(release_write.wait(timeout=5))
                db.add(
                    AIRunCancelRequest(
                        id="run_cancel-approval-write-race",
                        family_id=self.family.id,
                        run_id=data["run"]["id"],
                        requested_by=self.user.id,
                        status="requested",
                        outcome_code="cancel_requested",
                    )
                )
                db.flush()
                return business_entity, entity_ids

            def submit_approval() -> None:
                with self.client.stream(
                    "POST",
                    f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision/stream",
                    json=self._approval_payload(data),
                ) as response:
                    response_body["status_code"] = response.status_code
                    response_body["body"] = "".join(response.iter_text())
                response_done.set()

            with patch.object(approval_decisions, "execute_ai_operation_draft", side_effect=blocking_execute):
                worker = Thread(target=submit_approval)
                worker.start()
                self.assertTrue(business_written.wait(timeout=5))
                release_write.set()
                self.assertTrue(response_done.wait(timeout=5))
                worker.join(timeout=5)

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            cancel_request = db.scalar(
                select(AIRunCancelRequest).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == data["run"]["id"],
                )
            )
        after_operation_count, after_food_count, cancel_count = self._counts(run_id=data["run"]["id"])
        self.assertEqual(response_body["status_code"], 200)
        self.assertEqual(after_operation_count, before_operation_count + 1)
        self.assertEqual(after_food_count, before_food_count + 1)
        self.assertEqual(cancel_count, 1)
        self.assertEqual(provider.followup_calls, 0)
        self.assertIsNotNone(run)
        self.assertIsNotNone(cancel_request)
        assert run is not None and cancel_request is not None
        self.assertEqual(run.status, "cancelled")
        self.assertEqual(cancel_request.status, "applied")

    def test_approval_failure_rolls_back_business_write_but_keeps_cancel_request(self) -> None:
        data = self._create_food_profile_approval(suffix="失败回滚")
        approval = data["included"]["approvals"][0]
        before_operation_count, before_food_count, _ = self._counts(run_id=data["run"]["id"])
        cancel_recorded = Event()
        approval_started = Event()
        response_done = Event()
        response_status: dict[str, int] = {}

        with self.SessionLocal() as db:
            record_run_cancellation_request(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                run_id=data["run"]["id"],
            )
            db.commit()
        cancel_recorded.set()

        from app.services.ai_operations import approval_decisions

        original_execute = approval_decisions.execute_ai_operation_draft

        def failing_execute(db, **kwargs):
            business_entity, entity_ids = original_execute(db, **kwargs)
            del business_entity, entity_ids
            raise RuntimeError("approval write failed")

        def submit_approval() -> None:
            self.assertTrue(cancel_recorded.wait(timeout=5))
            approval_started.set()
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json=self._approval_payload(data),
            )
            response_status["value"] = response.status_code
            response_done.set()

        with (
            patch.object(approval_decisions, "execute_ai_operation_draft", side_effect=failing_execute),
            patch.object(approval_decisions, "cancellation_wins", side_effect=[False, True]),
        ):
            worker = Thread(target=submit_approval)
            worker.start()
            self.assertTrue(approval_started.wait(timeout=5))
            self.assertTrue(response_done.wait(timeout=5))
            worker.join(timeout=5)

        self.assertEqual(response_status["value"], 500)
        after_operation_count, after_food_count, cancel_count = self._counts(run_id=data["run"]["id"])
        self.assertEqual(after_operation_count, before_operation_count)
        self.assertEqual(after_food_count, before_food_count)
        self.assertEqual(cancel_count, 1)

        with self.SessionLocal() as db:
            request = db.scalar(
                select(AIRunCancelRequest).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == data["run"]["id"],
                )
            )
            self.assertIsNotNone(request)
            assert request is not None
            self.assertEqual(request.status, "requested")
            result = apply_run_cancellation_request(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                run_id=data["run"]["id"],
            )
            db.commit()
        self.assertEqual(result.outcome, "cancelled")
        self.assertEqual(result.request.status, "applied")

    def test_cancel_wins_before_human_input_resume(self) -> None:
        provider = HumanInputRaceProvider()
        data, request_id = self._create_waiting_human_input(provider)
        lock_requested = Event()
        cancellation_applied = Event()
        response_done = Event()
        response_status: dict[str, int] = {}

        from app.ai.workflows.runner_support import human_input_resume_preparer

        original_lock = getattr(human_input_resume_preparer, "lock_run_for_transition", None)

        def gated_lock(db, **kwargs):
            assert original_lock is not None
            lock_requested.set()
            self.assertTrue(cancellation_applied.wait(timeout=5))
            return original_lock(db, **kwargs)

        def submit_response() -> None:
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post(
                f"/api/ai/conversations/{data['conversation_id']}/human-input/{request_id}/response",
                json={"selected_option_ids": ["three-days"]},
            )
            response_status["value"] = response.status_code
            response_done.set()

        with patch.object(
            human_input_resume_preparer,
            "lock_run_for_transition",
            side_effect=gated_lock,
            create=True,
        ):
            worker = Thread(target=submit_response)
            worker.start()
            entered_lock = lock_requested.wait(timeout=2)
            if entered_lock:
                cancel_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/cancel")
                self.assertEqual(cancel_response.status_code, 200, cancel_response.text)
                cancellation_applied.set()
            self.assertTrue(response_done.wait(timeout=5))
            worker.join(timeout=5)

        self.assertTrue(entered_lock, "human-input resume did not acquire the run lock")
        self.assertEqual(response_status["value"], 409)
        self.assertEqual(self._human_result_artifact_count(message_id=data["message"]["id"]), 0)
        with self.SessionLocal() as db:
            message = db.get(AIMessage, data["message"]["id"])
            assert message is not None
            human_part = next(
                part
                for part in message.parts
                if part.get("type") == "human_input_request"
                and str((part.get("request") or {}).get("id") or "") == request_id
            )
        self.assertEqual(human_part["status"], "cancelled")

    def test_human_input_resume_commits_answer_once_then_cancel_stops_followup(self) -> None:
        provider = HumanInputRaceProvider()
        data, request_id = self._create_waiting_human_input(provider)
        preparer_locked = Event()
        cancellation_recorded = Event()
        response_done = Event()
        response_status: dict[str, int] = {}

        from app.ai.workflows.runner_support import (
            human_input_resume_handler,
            human_input_resume_preparer,
        )

        original_lock = getattr(human_input_resume_preparer, "lock_run_for_transition", None)
        original_update_message = human_input_resume_handler.HumanInputResumeHandler._update_message

        def observe_lock(db, **kwargs):
            assert original_lock is not None
            run = original_lock(db, **kwargs)
            preparer_locked.set()
            return run

        def update_message_then_cancel(handler, state, **kwargs):
            original_update_message(handler, state, **kwargs)
            handler.runner.db.add(
                AIRunCancelRequest(
                    id="run_cancel-human-input-resume-race",
                    family_id=self.family.id,
                    run_id=data["run"]["id"],
                    requested_by=self.user.id,
                    status="requested",
                    outcome_code="cancel_requested",
                )
            )
            handler.runner.db.flush()
            cancellation_recorded.set()

        def submit_response() -> None:
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post(
                f"/api/ai/conversations/{data['conversation_id']}/human-input/{request_id}/response",
                json={"selected_option_ids": ["three-days"]},
            )
            response_status["value"] = response.status_code
            response_done.set()

        with (
            patch.object(
                human_input_resume_preparer,
                "lock_run_for_transition",
                side_effect=observe_lock,
                create=True,
            ),
            patch.object(
                human_input_resume_handler.HumanInputResumeHandler,
                "_update_message",
                autospec=True,
                side_effect=update_message_then_cancel,
            ),
            patch("app.ai.workspace_service.get_chat_provider", return_value=provider),
        ):
            worker = Thread(target=submit_response)
            worker.start()
            entered_lock = preparer_locked.wait(timeout=2)
            self.assertTrue(response_done.wait(timeout=5))
            worker.join(timeout=5)

        self.assertTrue(entered_lock, "human-input resume did not acquire the run lock")
        self.assertTrue(cancellation_recorded.is_set())
        self.assertEqual(response_status["value"], 200)
        self.assertEqual(self._human_result_artifact_count(message_id=data["message"]["id"]), 1)
        self.assertEqual(provider.followup_calls, 0)
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "cancelled")
