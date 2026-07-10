import os
from pathlib import Path

from sqlalchemy import select

from app.ai.errors import ToolExecutionError
from app.ai.evals.loader import load_eval_cases
from app.ai.evals.scoring import score_case, score_report
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.models.domain import AIAgentRun, MediaAsset, RecipeIngredient
from tests.ai_infra._support import AIAgentInfraTestCase, AIEvalContext

CORE_CASES = load_eval_cases(Path(__file__).parent / "cases" / "core.jsonl")


class AIScriptedSkillScenariosTestCase(AIAgentInfraTestCase):
    def test_scripted_skill_scenarios(self) -> None:
        context = AIEvalContext(self)
        pairs = []
        failures = []
        for case in CORE_CASES:
            observation = context.run_case(case)
            pairs.append((case, observation))
            score = score_case(case=case, observation=observation)
            if not score.passed:
                failures.append(case.id + ": " + "; ".join(score.failures))

        report = score_report(pairs, source="scripted")
        output_path = os.getenv("CULINA_AI_EVAL_REPORT_PATH")
        if output_path:
            path = Path(output_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
        self.assertFalse(failures, "\n".join(failures))

    def test_eval_error_classification_rejects_unrelated_runtime_failure(self) -> None:
        context = AIEvalContext(self)
        case = next(item for item in CORE_CASES if item.id == "identity.cross_family_ingredient")

        self.assertEqual(
            context._error_code_from_runtime(case, runtime_error="AttributeError: broken handler"),
            "unexpected_runtime_error",
        )

    def test_eval_error_classification_uses_structured_runtime_code(self) -> None:
        context = AIEvalContext(self)
        case = next(item for item in CORE_CASES if item.id == "attachment.unknown_media")

        self.assertEqual(
            context._error_code_from_runtime(
                case,
                runtime_error="invalid_current_attachment",
                runtime_error_code="family_scope_violation",
            ),
            "family_scope_violation",
        )

    def test_identity_read_tools_emit_stable_runtime_codes(self) -> None:
        context = AIEvalContext(self)
        cases = (
            ("ingredient.read_by_id", context.aliases["other_family_ingredient"], "family_scope_violation"),
            ("food.read_by_id", context.aliases["other_family_food"], "family_scope_violation"),
            ("recipe.read_by_id", context.aliases["other_family_recipe"], "family_scope_violation"),
            ("ingredient.read_by_id", context.aliases["fabricated_id"], "unknown_entity_id"),
        )
        with self.SessionLocal() as db:
            for tool_name, entity_id, expected_code in cases:
                with self.subTest(tool_name=tool_name, entity_id=entity_id):
                    executor = ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-eval-identity",
                            run_id="run-eval-identity",
                        ),
                        allowed_tools={tool_name},
                    )
                    with self.assertRaises(ToolExecutionError) as raised:
                        executor.call(tool_name, {"id": entity_id})
                    self.assertEqual(raised.exception.code, expected_code)

    def test_eval_business_snapshot_detects_other_family_media_update(self) -> None:
        context = AIEvalContext(self)
        with self.SessionLocal() as db:
            before = context._business_snapshot(db)
            media = db.get(MediaAsset, context.aliases["other_family_media"])
            assert media is not None
            media.alt = "被意外修改"
            db.commit()
            after = context._business_snapshot(db)

        self.assertEqual(context._unexpected_business_write_count(before, after), 1)

    def test_eval_business_snapshot_detects_recipe_ingredient_update(self) -> None:
        context = AIEvalContext(self)
        with self.SessionLocal() as db:
            before = context._business_snapshot(db)
            item = db.get(RecipeIngredient, "recipe-eval-tomato")
            assert item is not None
            item.note = "被意外修改"
            db.commit()
            after = context._business_snapshot(db)

        self.assertEqual(context._unexpected_business_write_count(before, after), 1)

    def test_unknown_attachment_rejection_updates_online_identity_metric(self) -> None:
        context = AIEvalContext(self)
        case = next(item for item in CORE_CASES if item.id == "attachment.unknown_media")

        context.run_case(case)

        with self.SessionLocal() as db:
            run = db.scalars(select(AIAgentRun).order_by(AIAgentRun.created_at.desc())).first()
            assert run is not None
            metrics = run.context_summary["runMetrics"]
        self.assertEqual(metrics["invalidIdentityRejectedCount"], 1)

    def test_stale_attachment_rejection_is_not_an_identity_rejection(self) -> None:
        context = AIEvalContext(self)
        case = next(item for item in CORE_CASES if item.id == "attachment.previous_message")

        context.run_case(case)

        with self.SessionLocal() as db:
            run = db.scalars(select(AIAgentRun).order_by(AIAgentRun.created_at.desc())).first()
            assert run is not None
            metrics = run.context_summary["runMetrics"]
        self.assertEqual(metrics.get("invalidIdentityRejectedCount", 0), 0)
