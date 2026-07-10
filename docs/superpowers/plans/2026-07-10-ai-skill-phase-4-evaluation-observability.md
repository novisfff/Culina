# AI Skill Phase 4 Evaluation and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Skill routing, Tool use, draft quality, continuation completion, and approval edits measurable with a deterministic PR gate and family-scoped runtime diagnostics.

**Architecture:** Add a versioned JSONL scenario contract and pure scoring library first. Run deterministic scripted scenarios against the real Orchestrator and Skill registry in CI; keep real-provider semantic observations in the same report format but outside the blocking PR gate. Extend existing AIAgentRun context summaries and AI approval rows for online aggregation, avoiding a second analytics database.

**Tech Stack:** Python 3.12, Pydantic, pytest, JSONL, FastAPI, SQLAlchemy 2, React 18, TypeScript, Vitest, GitHub Actions.

## Global Constraints

- Phase 1 through Phase 3 must be merged before establishing the baseline.
- The PR gate must never call a paid or nondeterministic provider.
- Scripted evaluation must exercise the real Skill loader, profile policy, Tool registry, draft validator, and continuation validator.
- Semantic routing quality from a real provider is reported separately and must not block PRs until a stable reviewed baseline exists.
- Eval inputs contain no production family names, member names, images, tokens, or persistent entity IDs.
- Invalid-identity cases pass only when the system rejects the write; a graceful error is success for that case.
- Online quality endpoints remain current-family scoped under the existing authenticated-membership authorization rule; this phase does not widen or narrow access.
- No new database table is introduced. New counters live in AIAgentRun.context_summary; approval edit metrics derive from existing AIApprovalRequest fields.
- Rates must expose numerator and denominator as well as the rounded rate. Empty denominators return null, not 0 or 100 percent.
- The frontend must label these as operational quality indicators, not model certainty or health advice.
- All final verification commands actually run during implementation must be reported.

---

## File Structure

Create:

- backend/app/ai/evals/__init__.py: public evaluation interfaces.
- backend/app/ai/evals/models.py: case, observation, case-score, and report models.
- backend/app/ai/evals/loader.py: strict JSONL loading and duplicate detection.
- backend/app/ai/evals/scoring.py: deterministic invariant and rate scoring.
- backend/app/ai/evals/scripted_provider.py: evaluation-only scripted provider.
- backend/app/ai/evals/thresholds.py: threshold contract and failure messages.
- backend/tests/ai_evals/cases/core.jsonl: reviewed core scenario dataset.
- backend/tests/ai_evals/test_eval_dataset.py: dataset schema and coverage tests.
- backend/tests/ai_evals/test_skill_scenarios.py: real runtime scripted scenario tests.
- backend/tests/ai_evals/test_eval_scoring.py: pure scorer tests.
- backend/scripts/run_ai_skill_evals.py: score observation JSONL and write a report.
- backend/scripts/check_ai_skill_eval_report.py: enforce deterministic thresholds.
- backend/ai_eval_thresholds.json: committed blocking thresholds.
- frontend/src/components/ai/AiQualityMetricsModel.test.ts: rate and label tests.

Modify:

- backend/app/ai/workflows/runner_support/run_summary.py: record route, validation, identity, budget, and continuation counters.
- backend/app/ai/workflows/orchestrator/continuation.py: record continuation lifecycle.
- backend/app/ai/workflows/orchestrator/draft_capture.py: record first-pass validation.
- backend/app/ai/workflows/orchestrator/tool_budget.py: record exhaustion.
- backend/app/services/ai_quality.py: aggregate online indicators and approval edits.
- backend/app/schemas/ai.py: response DTOs for the new indicators.
- backend/tests/ai_infra/test_foundation.py: counter behavior.
- backend/tests/ai_infra/test_registry_and_metrics.py: family-scoped endpoint aggregation.
- frontend/src/api/types.ts: quality metric response types.
- frontend/src/components/ai/AiQualityMetricsModel.ts: pure indicator calculations.
- frontend/src/components/ai/AiQualityDiagnosticsCard.tsx: compact indicator summary.
- frontend/src/components/ai/AiQualityDiagnosticsModal.tsx: counts, rates, and explanation.
- frontend/src/components/ai/AiWorkspaceQualityDiagnostics.test.tsx: rendered states.
- package.json: evaluation scripts.
- .gitignore: exclude generated local evaluation reports.
- .github/workflows/quality-gates.yml: deterministic AI evaluation job.
- docs/ai-assistant-standards.md: evaluation ownership and release rules.

---

### Task 1: Define a Strict, Versioned Evaluation Contract

**Files:**
- Create: backend/app/ai/evals/__init__.py
- Create: backend/app/ai/evals/models.py
- Create: backend/app/ai/evals/loader.py
- Create: backend/tests/ai_evals/test_eval_dataset.py

**Interfaces:**
- Produces: SkillEvalCase, SkillEvalObservation, SkillEvalCaseScore, SkillEvalReport.
- Consumed by: scripted scenario tests, offline scorer, threshold checker, and future real-provider capture.

- [ ] **Step 1: Write failing model and loader tests**

Create tests that require strict fields and unique IDs:

    def test_load_cases_rejects_duplicate_id(tmp_path: Path) -> None:
        path = tmp_path / "cases.jsonl"
        path.write_text(
            '{"schemaVersion":"skill_eval_case.v1","id":"duplicate","message":"查库存","expectedSkills":["inventory_analysis"]}\n'
            '{"schemaVersion":"skill_eval_case.v1","id":"duplicate","message":"再查一次","expectedSkills":["inventory_analysis"]}\n',
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="duplicate eval case id"):
            load_eval_cases(path)

    def test_eval_case_rejects_unknown_fields() -> None:
        with pytest.raises(ValidationError):
            SkillEvalCase.model_validate({
                "schemaVersion": "skill_eval_case.v1",
                "id": "bad-field",
                "message": "查库存",
                "expectedSkills": ["inventory_analysis"],
                "unexpected": True,
            })

    def test_observation_requires_matching_case_id() -> None:
        with pytest.raises(ValueError, match="missing observations"):
            join_cases_and_observations(
                cases=[case("inventory.available")],
                observations=[],
            )

- [ ] **Step 2: Run tests and confirm imports fail**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_dataset.py -q

Expected: collection fails because the eval package does not exist.

- [ ] **Step 3: Implement the exact Pydantic contracts**

Use ConfigDict(extra="forbid") for every model:

    class SkillEvalCase(BaseModel):
        model_config = ConfigDict(extra="forbid")

        schemaVersion: Literal["skill_eval_case.v1"]
        id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]+$")
        category: Literal[
            "routing",
            "query",
            "draft",
            "continuation",
            "identity_boundary",
            "attachment_boundary",
            "clarification",
        ]
        message: str = Field(min_length=1, max_length=500)
        quickTask: str | None = None
        subject: dict[str, Any] = Field(default_factory=dict)
        expectedSkills: list[str] = Field(default_factory=list)
        forbiddenSkills: list[str] = Field(default_factory=list)
        expectedTools: list[str] = Field(default_factory=list)
        forbiddenTools: list[str] = Field(default_factory=list)
        expectedDraftType: str | None = None
        expectedContinuationSchema: str | None = None
        expectedErrorCode: str | None = None
        expectedTerminalStatus: Literal[
            "completed",
            "waiting_approval",
            "waiting_human_input",
            "rejected",
        ]
        expectsFirstPassDraft: bool = False
        expectsIdentityRejection: bool = False
        script: list[dict[str, Any]] = Field(min_length=1)

    class SkillEvalObservation(BaseModel):
        model_config = ConfigDict(extra="forbid")

        schemaVersion: Literal["skill_eval_observation.v1"]
        caseId: str
        source: Literal["scripted", "real_provider"]
        skills: list[str] = Field(default_factory=list)
        tools: list[str] = Field(default_factory=list)
        draftType: str | None = None
        continuationSchema: str | None = None
        terminalStatus: str
        draftValidationAttempts: int = Field(default=0, ge=0)
        invalidIdentityWriteCount: int = Field(default=0, ge=0)
        errorCode: str | None = None

    class RateMetric(BaseModel):
        numerator: int = Field(ge=0)
        denominator: int = Field(ge=0)
        rate: float | None = Field(default=None, ge=0, le=1)

    class SkillEvalCaseScore(BaseModel):
        caseId: str
        passed: bool
        routingPassed: bool
        toolContractPassed: bool
        terminalPassed: bool
        draftPassed: bool
        continuationPassed: bool
        identityBoundaryPassed: bool
        failures: list[str] = Field(default_factory=list)

    class SkillEvalReport(BaseModel):
        schemaVersion: Literal["skill_eval_report.v1"]
        source: Literal["scripted", "real_provider"]
        generatedAt: datetime
        caseCount: int
        passedCaseCount: int
        metrics: dict[str, RateMetric]
        invalidIdentityWriteCount: int
        cases: list[SkillEvalCaseScore]

- [ ] **Step 4: Implement strict JSONL loading**

loader.py must:

1. Skip only empty lines.
2. Parse each non-empty line as one JSON object.
3. Include path and one-based line number in malformed JSON or validation errors.
4. Reject duplicate caseId or id values.
5. Reject missing or extra observations when joining against a case set.
6. Sort joined pairs by case ID for stable reports.

Do not silently coerce a JSON array or YAML file.

- [ ] **Step 5: Run tests and commit**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_dataset.py -q

Expected: all contract and loader tests pass.

Commit:

    git add backend/app/ai/evals backend/tests/ai_evals/test_eval_dataset.py
    git commit -m "test(ai): define skill evaluation contracts"

---

### Task 2: Create the Reviewed Core Scenario Dataset

**Files:**
- Create: backend/tests/ai_evals/cases/core.jsonl
- Modify: backend/tests/ai_evals/test_eval_dataset.py
- Test: backend/tests/ai_evals/test_eval_dataset.py

**Interfaces:**
- Produces: exactly 32 versioned cases for the initial baseline.
- Covers: all nine Skills, four product continuations, family identity boundaries, attachment boundaries, and clarification behavior.

- [ ] **Step 1: Add a failing coverage test before the data file**

    def test_core_dataset_has_required_coverage() -> None:
        cases = load_eval_cases(CORE_CASES)
        assert len(cases) == 32
        covered_skills = {
            skill
            for case in cases
            for skill in case.expectedSkills
        }
        assert covered_skills == {
            "cooking_assistant",
            "food_profile",
            "ingredient_profile",
            "inventory_analysis",
            "meal_plan",
            "meal_log",
            "recipe_cook",
            "recipe_draft",
            "shopping_list",
        }
        assert sum(case.category == "identity_boundary" for case in cases) == 5
        assert sum(case.category == "attachment_boundary" for case in cases) == 3
        assert sum(case.category == "continuation" for case in cases) == 5

- [ ] **Step 2: Run the test and confirm the data file is absent**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_dataset.py -q

Expected: FileNotFoundError for core.jsonl.

- [ ] **Step 3: Add these exact 32 case IDs and intents**

Each JSONL row must satisfy SkillEvalCase and contain a complete scripted provider response list. Use these IDs:

| ID | Category | Expected Skill or boundary |
|---|---|---|
| inventory.available | query | inventory_analysis available card |
| inventory.low_stock_zero | query | inventory_analysis includes depleted item |
| inventory.expiring | query | inventory_analysis expiring card |
| inventory.intake_preview | draft | inventory_analysis candidate preview, no draft |
| shopping.add_ingredient | draft | shopping_list ingredient draft |
| shopping.add_ready_food | draft | shopping_list Food draft |
| shopping.complete_to_ingredient_stock | continuation | shopping_to_stock.v1 to inventory_analysis |
| shopping.complete_to_food_stock | continuation | shopping_to_stock.v1 to food_profile |
| recipe.create | draft | recipe_draft |
| recipe.image_create | draft | recipe_draft current attachment |
| recipe.cook_ready | draft | recipe_cook draft |
| recipe.cook_shortage | continuation | recipe_shortage_to_shopping.v1 |
| meal.plan_existing_recipe | draft | meal_plan with real Recipe ID |
| meal.plan_existing_food | draft | meal_plan with real Food ID |
| meal.plan_empty_library | query | meal_idea_proposal card, no fabricated entity |
| meal.log_recipe | draft | meal_log recipe item |
| meal.log_ready_food_no_deduct | draft | meal_log, deduction false |
| meal.log_ready_food_deduct | draft | meal_log, deduction true |
| food.create_to_meal_plan | continuation | food_profile draft with food_to_meal_plan.v1 |
| ingredient.create_profile | draft | ingredient_profile |
| cooking.next_step | routing | fixed cooking_assistant profile |
| identity.cross_family_ingredient | identity_boundary | reject ingredient ID |
| identity.cross_family_food | identity_boundary | reject Food ID |
| identity.cross_family_recipe | identity_boundary | reject Recipe ID |
| identity.cross_family_media | identity_boundary | reject media ID |
| identity.fabricated_id | identity_boundary | reject invented ID |
| attachment.current_recipe | attachment_boundary | accept current attachment |
| attachment.previous_message | attachment_boundary | reject stale attachment |
| attachment.unknown_media | attachment_boundary | reject unknown attachment |
| clarification.ambiguous_food | clarification | wait for Food selection |
| clarification.missing_ingredient_first | clarification | one ingredient draft only |
| continuation.missing_ingredient_resume | continuation | resume original Skill after approval |

For every write-oriented row, script the real sequence: Skill injection, search/read, proposal, draft Tool call, and terminal result. For every negative row, script the invalid call and expected stable error code. Do not copy production IDs; use fixture aliases in subject fields and resolve them during test setup.

- [ ] **Step 4: Validate every referenced Skill, Tool, draft type, and continuation schema**

Extend the coverage test to load the actual Skill and Tool registries. Assert:

- expectedSkills and forbiddenSkills reference loaded Skill keys.
- expectedTools and forbiddenTools reference registered Tool names.
- expectedDraftType is in AITaskDraftType.
- expectedContinuationSchema is registered in CONTINUATION_STATE_SCHEMAS.
- script Tool calls use only Tools visible under the expected execution record.

- [ ] **Step 5: Run dataset validation and commit**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_dataset.py -q

Expected: exactly 32 cases load and every reference resolves.

Commit:

    git add backend/tests/ai_evals/cases/core.jsonl backend/tests/ai_evals/test_eval_dataset.py
    git commit -m "test(ai): add core skill scenario dataset"

---

### Task 3: Implement Pure Scoring With Explicit Denominators

**Files:**
- Create: backend/app/ai/evals/scoring.py
- Create: backend/tests/ai_evals/test_eval_scoring.py

**Interfaces:**
- Consumes: a complete one-to-one list of case and observation pairs.
- Produces: skill_eval_report.v1 with deterministic ordering and machine-readable failures.

- [ ] **Step 1: Write failing scorer tests**

    def test_score_case_reports_forbidden_tool_and_missing_skill() -> None:
        score = score_case(
            case=case(
                expectedSkills=["shopping_list"],
                expectedTools=["shopping.create_draft"],
                forbiddenTools=["inventory.create_operation_draft"],
            ),
            observation=observation(
                skills=[],
                tools=["inventory.create_operation_draft"],
            ),
        )
        assert score.passed is False
        assert score.routingPassed is False
        assert score.toolContractPassed is False
        assert score.failures == [
            "missing skills: shopping_list",
            "missing tools: shopping.create_draft",
            "forbidden tools used: inventory.create_operation_draft",
        ]

    def test_empty_metric_denominator_returns_null_rate() -> None:
        metric = build_rate(0, 0)
        assert metric.model_dump() == {
            "numerator": 0,
            "denominator": 0,
            "rate": None,
        }

    def test_first_pass_rate_counts_only_expected_drafts() -> None:
        report = score_report([draft_pair(attempts=1), query_pair()])
        assert report.metrics["draftFirstPassRate"].denominator == 1
        assert report.metrics["draftFirstPassRate"].numerator == 1

- [ ] **Step 2: Run tests and confirm scorer imports fail**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_scoring.py -q

Expected: collection fails because scoring.py is absent.

- [ ] **Step 3: Implement exact case rules**

Use set containment, not list-order equality:

    def score_case(
        *,
        case: SkillEvalCase,
        observation: SkillEvalObservation,
    ) -> SkillEvalCaseScore:
        failures: list[str] = []
        actual_skills = set(observation.skills)
        actual_tools = set(observation.tools)

        append_set_failure(
            failures,
            "missing skills",
            set(case.expectedSkills) - actual_skills,
        )
        append_set_failure(
            failures,
            "forbidden skills used",
            set(case.forbiddenSkills) & actual_skills,
        )
        routing_passed = not failures

        tool_failure_start = len(failures)
        append_set_failure(
            failures,
            "missing tools",
            set(case.expectedTools) - actual_tools,
        )
        append_set_failure(
            failures,
            "forbidden tools used",
            set(case.forbiddenTools) & actual_tools,
        )
        tool_passed = len(failures) == tool_failure_start

        terminal_passed = observation.terminalStatus == case.expectedTerminalStatus
        if not terminal_passed:
            failures.append(
                "terminal status expected "
                + case.expectedTerminalStatus
                + " got "
                + observation.terminalStatus
            )

        draft_passed = observation.draftType == case.expectedDraftType
        if not draft_passed:
            failures.append(
                "draft type expected "
                + str(case.expectedDraftType)
                + " got "
                + str(observation.draftType)
            )

        continuation_passed = (
            observation.continuationSchema == case.expectedContinuationSchema
        )
        if not continuation_passed:
            failures.append(
                "continuation expected "
                + str(case.expectedContinuationSchema)
                + " got "
                + str(observation.continuationSchema)
            )

        identity_passed = observation.invalidIdentityWriteCount == 0
        if not identity_passed:
            failures.append("invalid identity write count is non-zero")
        if (
            case.expectsIdentityRejection
            and observation.errorCode != case.expectedErrorCode
        ):
            identity_passed = False
            failures.append(
                "error code expected "
                + str(case.expectedErrorCode)
                + " got "
                + str(observation.errorCode)
            )

        return SkillEvalCaseScore(
            caseId=case.id,
            passed=not failures,
            routingPassed=routing_passed,
            toolContractPassed=tool_passed,
            terminalPassed=terminal_passed,
            draftPassed=draft_passed,
            continuationPassed=continuation_passed,
            identityBoundaryPassed=identity_passed,
            failures=failures,
        )

For expectsIdentityRejection cases, additionally require terminalStatus =
rejected or waiting_human_input, require observation.errorCode to exactly equal
case.expectedErrorCode, and still require invalidIdentityWriteCount = 0. Every
identity-boundary dataset row must therefore declare a stable expected error
code.

- [ ] **Step 4: Implement report formulas**

Report these metrics:

- casePassRate: passed cases divided by all cases.
- routingContractRate: routingPassed divided by all cases.
- toolContractRate: toolContractPassed divided by all cases.
- terminalContractRate: terminalPassed divided by all cases.
- draftFirstPassRate: expected draft cases with exactly one validation attempt divided by expected draft cases.
- continuationContractRate: continuationPassed divided by cases with expectedContinuationSchema.
- identityBoundaryRate: zero-write rejected identity cases divided by identity-boundary cases.

Round rate to four decimal places and retain numerator and denominator.

- [ ] **Step 5: Run tests and commit**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_scoring.py -q

Expected: exact failure ordering and all rate formulas pass.

Commit:

    git add backend/app/ai/evals/scoring.py backend/tests/ai_evals/test_eval_scoring.py
    git commit -m "test(ai): add deterministic skill evaluation scoring"

---

### Task 4: Run Scripted Cases Through the Real Runtime

**Files:**
- Create: backend/app/ai/evals/scripted_provider.py
- Create: backend/tests/ai_evals/test_skill_scenarios.py
- Modify: backend/tests/ai_infra/_support.py
- Test: backend/tests/ai_evals/test_skill_scenarios.py

**Interfaces:**
- Consumes: each case script and fixture aliases.
- Produces: SkillEvalObservation derived from persisted run, trace, draft, and continuation data.
- Exercises: real profile selection, Skill injection, Tool registry, draft validation, approval pause, and error policy.

- [ ] **Step 1: Write the failing scenario test and report collector**

    import os


    CORE_CASES = load_eval_cases(
        Path(__file__).parent / "cases" / "core.jsonl"
    )

    def test_scripted_skill_scenarios(
        ai_eval_context: AIEvalContext,
    ) -> None:
        pairs: list[
            tuple[SkillEvalCase, SkillEvalObservation]
        ] = []
        failures: list[str] = []
        for case in CORE_CASES:
            observation = ai_eval_context.run_case(case)
            pairs.append((case, observation))
            score = score_case(
                case=case,
                observation=observation,
            )
            if not score.passed:
                failures.append(
                    case.id + ": " + "; ".join(score.failures)
                )

        report = score_report(pairs, source="scripted")
        output_path = os.getenv("CULINA_AI_EVAL_REPORT_PATH")
        if output_path:
            path = Path(output_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                report.model_dump_json(indent=2),
                encoding="utf-8",
            )

        assert not failures, "\n".join(failures)

- [ ] **Step 2: Run tests and confirm the fixture/provider is missing**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_skill_scenarios.py -q

Expected: collection fails because AIEvalContext and ScriptedEvalProvider do not exist.

- [ ] **Step 3: Implement an evaluation-only scripted provider**

ScriptedEvalProvider implements the existing provider protocol and consumes responses in order. Each response may contain assistant text, Tool calls, or an expected provider-side failure. It must fail immediately on:

- an unexpected extra provider round,
- a script entry left unused,
- a Tool call whose name or arguments differ from the case,
- an attempt to call a Tool outside the current execution record.

Keep this provider under app.ai.evals and never select it from production settings.

- [ ] **Step 4: Build a fixture context with stable aliases**

AIEvalContext must create one family with:

- ingredient aliases tomato, egg, salt, and other_family_ingredient,
- ready Food alias dumpling,
- recipe Food and Recipe aliases tomato_egg,
- one shopping item,
- current, stale, and other-family media,
- inventory batches including a zero-stock tracked ingredient,
- a deterministic Asia/Shanghai clock instant.

Before passing subject or script arguments to the provider, recursively replace strings of the form alias:tomato with the generated ID. Do not allow an unresolved alias to reach the runtime.

- [ ] **Step 5: Derive observations from persisted truth**

After the run, build SkillEvalObservation from:

- routing.skills and skillExecutions in AIAgentRun.context_summary,
- AIRunTraceSpan tool_call names,
- the run's AITaskDraft type and validation attempts,
- ai_metadata.continuation.schemaVersion,
- final run/pending-human-input status,
- identity rejection spans and persisted business rows.

For invalidIdentityWriteCount, query the scoped business tables before and after the case and count unexpected inserts or updates. Do not infer this value only from error text.

- [ ] **Step 6: Run all 32 scripted cases**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_skill_scenarios.py -q

Expected: 32 cases pass against the actual registries and runtime.

- [ ] **Step 7: Commit**

    git add backend/app/ai/evals/scripted_provider.py backend/tests/ai_evals/test_skill_scenarios.py backend/tests/ai_infra/_support.py
    git commit -m "test(ai): execute scripted skill scenarios"

---

### Task 5: Add a Reproducible Report CLI and Blocking Thresholds

**Files:**
- Create: backend/app/ai/evals/thresholds.py
- Create: backend/scripts/run_ai_skill_evals.py
- Create: backend/scripts/check_ai_skill_eval_report.py
- Create: backend/ai_eval_thresholds.json
- Modify: package.json
- Modify: .gitignore
- Test: backend/tests/ai_evals/test_eval_scoring.py

**Interfaces:**
- run_ai_skill_evals.py consumes cases plus observations and writes skill_eval_report.v1.
- check_ai_skill_eval_report.py consumes a report plus thresholds and exits non-zero on regression.

- [ ] **Step 1: Write failing threshold tests**

    def test_thresholds_fail_with_actionable_messages() -> None:
        failures = check_thresholds(
            report=report(
                case_count=31,
                routing_rate=0.9687,
                invalid_identity_write_count=1,
            ),
            thresholds=thresholds(),
        )
        assert failures == [
            "caseCount: expected at least 32, got 31",
            "routingContractRate: expected at least 1.0000, got 0.9687",
            "invalidIdentityWriteCount: expected 0, got 1",
        ]

- [ ] **Step 2: Run tests and confirm threshold imports fail**

Run:

    backend/.venv/bin/pytest backend/tests/ai_evals/test_eval_scoring.py -q

Expected: failure because thresholds.py does not exist.

- [ ] **Step 3: Add exact initial thresholds**

backend/ai_eval_thresholds.json:

    {
      "schemaVersion": "skill_eval_thresholds.v1",
      "minimumCaseCount": 32,
      "minimumRates": {
        "casePassRate": 1.0,
        "routingContractRate": 1.0,
        "toolContractRate": 1.0,
        "terminalContractRate": 1.0,
        "draftFirstPassRate": 0.95,
        "continuationContractRate": 1.0,
        "identityBoundaryRate": 1.0
      },
      "maximumInvalidIdentityWriteCount": 0
    }

The threshold checker must reject unknown metric names, a report source other than scripted, and a report whose case IDs do not match the loaded core dataset.

- [ ] **Step 4: Implement CLI behavior**

run_ai_skill_evals.py arguments:

    --cases PATH
    --observations PATH
    --output PATH

It loads, joins, scores, writes indented UTF-8 JSON, and prints one concise summary line. It does not overwrite an existing output unless --force is passed.
All observations in one input file must have the same source; the CLI copies
that source to the report and rejects mixed scripted and real_provider rows.

check_ai_skill_eval_report.py arguments:

    --report PATH
    --thresholds PATH
    --cases PATH

It prints each failed threshold to stderr and exits 1; otherwise prints the case count and rates and exits 0.

- [ ] **Step 5: Add package scripts**

Add:

    "backend:test:ai-evals": "cd backend && .venv/bin/python -m pytest tests/ai_evals",
    "backend:check:ai-evals": "cd backend && .venv/bin/python scripts/check_ai_skill_eval_report.py --report .artifacts/ai-skill-eval-report.json --thresholds ai_eval_thresholds.json --cases tests/ai_evals/cases/core.jsonl"

The scripted test runner writes observations and report only when CULINA_AI_EVAL_REPORT_PATH is set. Normal local pytest remains side-effect free.
Add `backend/.artifacts/` to `.gitignore`; reports are CI artifacts or local
diagnostics and must not be committed.

- [ ] **Step 6: Exercise success and intentional failure**

Run:

    mkdir -p backend/.artifacts
    CULINA_AI_EVAL_REPORT_PATH=.artifacts/ai-skill-eval-report.json npm run backend:test:ai-evals
    npm run backend:check:ai-evals
    cp backend/ai_eval_thresholds.json /tmp/culina-ai-eval-thresholds.json
    backend/.venv/bin/python -c "import json; p='/tmp/culina-ai-eval-thresholds.json'; d=json.load(open(p)); d['minimumCaseCount']=33; open(p,'w').write(json.dumps(d))"
    cd backend && .venv/bin/python scripts/check_ai_skill_eval_report.py --report .artifacts/ai-skill-eval-report.json --thresholds /tmp/culina-ai-eval-thresholds.json --cases tests/ai_evals/cases/core.jsonl

Expected: the first checker exits 0. The final intentional check exits 1 with “expected at least 33, got 32”.

- [ ] **Step 7: Commit**

    git add backend/app/ai/evals/thresholds.py backend/scripts/run_ai_skill_evals.py backend/scripts/check_ai_skill_eval_report.py backend/ai_eval_thresholds.json backend/tests/ai_evals/test_eval_scoring.py package.json .gitignore
    git commit -m "ci(ai): add skill evaluation thresholds"

---

### Task 6: Record Online Draft, Identity, Budget, and Continuation Indicators

**Files:**
- Modify: backend/app/ai/workflows/runner_support/run_summary.py
- Modify: backend/app/ai/workflows/orchestrator/continuation.py
- Modify: backend/app/ai/workflows/orchestrator/draft_capture.py
- Modify: backend/app/ai/workflows/orchestrator/tool_budget.py
- Modify: backend/tests/ai_infra/test_foundation.py

**Interfaces:**
- Adds counters to context_summary.runMetrics without schema migration.
- Consumed by: build_ai_quality_metrics.

- [ ] **Step 1: Write failing counter and idempotency tests**

    def test_quality_counters_record_first_pass_and_continuation() -> None:
        summary: dict[str, Any] = {}
        record_draft_validation(
            summary,
            candidate_key="tool-call-1",
            succeeded=True,
            attempt=1,
        )
        record_continuation_started(summary, workflow_id="flow-1")
        record_continuation_completed(summary, workflow_id="flow-1")
        assert summary["runMetrics"] == {
            "draftValidationCandidateCount": 1,
            "draftValidationAttemptCount": 1,
            "draftFirstPassSuccessCount": 1,
            "continuationStartedCount": 1,
            "continuationCompletedCount": 1,
        }

    def test_continuation_counter_is_idempotent_per_workflow() -> None:
        summary: dict[str, Any] = {}
        record_continuation_started(summary, workflow_id="flow-1")
        record_continuation_started(summary, workflow_id="flow-1")
        assert summary["runMetrics"]["continuationStartedCount"] == 1

- [ ] **Step 2: Run tests and confirm helpers are missing**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_foundation.py -k quality_counter -q

Expected: import or assertion failures.

- [ ] **Step 3: Add exact counters**

Extend QUALITY_METRIC_KEYS and run-summary helpers with:

- routeSelectionCount
- draftValidationCandidateCount
- draftValidationAttemptCount
- draftFirstPassSuccessCount
- invalidIdentityRejectedCount
- toolBudgetExhaustedCount
- continuationStartedCount
- continuationCompletedCount
- continuationRejectedCount

Store seen draft candidate keys and continuation workflow IDs under
context_summary.qualityDedup. Use candidate_key from the Tool call ID so a
retry increments attempt count but not candidate count. Store continuation IDs
under continuationStarted and related arrays so retries do not increment
twice. Cap each dedup array at 20 IDs.

- [ ] **Step 4: Instrument stable decision points**

- Increment routeSelectionCount after profile policy accepts the selected routing Skills.
- Increment draftValidationCandidateCount once per draft Tool call, draftValidationAttemptCount on each formal validation attempt, and draftFirstPassSuccessCount only when attempt 1 succeeds.
- Increment invalidIdentityRejectedCount only for stable family-scope or unknown-ID validation codes, not all Tool errors.
- Increment toolBudgetExhaustedCount where the runtime emits the existing budget exhaustion error.
- Start continuation when a validated typed continuation is persisted.
- Complete it after the receiving Skill reaches its declared terminal draft, card, or text output.
- Reject it when validation fails or the user explicitly cancels the continuation.

- [ ] **Step 5: Run focused and full AI infrastructure tests**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_foundation.py -q
    backend/.venv/bin/pytest backend/tests/ai_infra -q

Expected: counters are additive, retries are idempotent, and existing run summary keys remain compatible.

- [ ] **Step 6: Commit**

    git add backend/app/ai/workflows/runner_support/run_summary.py backend/app/ai/workflows/orchestrator/continuation.py backend/app/ai/workflows/orchestrator/draft_capture.py backend/app/ai/workflows/orchestrator/tool_budget.py backend/tests/ai_infra/test_foundation.py
    git commit -m "feat(ai): record skill quality lifecycle counters"

---

### Task 7: Aggregate Approval Edit Rate and Runtime Quality Indicators

**Files:**
- Modify: backend/app/services/ai_quality.py
- Modify: backend/app/schemas/ai.py
- Modify: backend/tests/ai_infra/test_registry_and_metrics.py

**Interfaces:**
- Produces: operational_metrics with numerator, denominator, and nullable rate values.
- Derives: approval edit rate from AIApprovalRequest.initial_values and submitted_values.

- [ ] **Step 1: Write failing family-scoped aggregation tests**

    def test_quality_metrics_include_operational_rates(self) -> None:
        response = self.client.get("/api/ai/quality-metrics?limit=10")
        assert response.status_code == 200
        metrics = response.json()["operational_metrics"]
        assert metrics["draftFirstPassRate"] == {
            "numerator": 4,
            "denominator": 5,
            "rate": 0.8,
        }
        assert metrics["continuationCompletionRate"] == {
            "numerator": 2,
            "denominator": 3,
            "rate": 0.6667,
        }
        assert metrics["approvalUneditedRate"] == {
            "numerator": 1,
            "denominator": 2,
            "rate": 0.5,
        }

    def test_approval_edit_rate_excludes_other_family(self) -> None:
        create_edited_approval(family_id=self.other_family.id)
        response = self.client.get("/api/ai/quality-metrics?limit=10")
        assert response.json()["operational_metrics"]["approvalUneditedRate"]["denominator"] == 2

- [ ] **Step 2: Run tests and confirm operational_metrics is absent**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_registry_and_metrics.py -k operational -q

Expected: response schema or key assertions fail.

- [ ] **Step 3: Implement canonical approval comparison**

Canonicalize recursively:

    def canonicalize_approval_value(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: canonicalize_approval_value(value[key])
                for key in sorted(value)
                if key not in {"comment", "clientOnly"}
            }
        if isinstance(value, list):
            return [canonicalize_approval_value(item) for item in value]
        if isinstance(value, str):
            return value.strip()
        return value

An approval is unedited when it is approved, submitted_values is non-empty, and canonical initial and submitted values are equal. Rejected, cancelled, expired, and still-pending approvals are excluded from this denominator.

Load approvals with both `AIApprovalRequest.family_id == family_id` and
`AIApprovalRequest.run_id.in_(run_ids)` so the edit-rate window matches the
same recent runs used for all other quality metrics.

- [ ] **Step 4: Add operational metrics**

Return:

    "operational_metrics": {
        "draftFirstPassRate": build_rate(
            totals["draftFirstPassSuccessCount"],
            totals["draftValidationCandidateCount"],
        ),
        "continuationCompletionRate": build_rate(
            totals["continuationCompletedCount"],
            totals["continuationStartedCount"],
        ),
        "approvalUneditedRate": build_rate(
            unedited_approval_count,
            resolved_approved_count,
        ),
        "invalidIdentityRejectedCount": totals["invalidIdentityRejectedCount"],
        "toolBudgetExhaustedCount": totals["toolBudgetExhaustedCount"],
        "continuationRejectedCount": totals["continuationRejectedCount"],
    }

Add corresponding Pydantic DTOs. Use the same four-decimal rate helper as eval scoring to prevent formula drift.

- [ ] **Step 5: Run endpoint and schema tests**

Run:

    backend/.venv/bin/pytest backend/tests/ai_infra/test_registry_and_metrics.py -q

Expected: totals, recent runs, traces, family isolation, and operational rates all pass.

- [ ] **Step 6: Commit**

    git add backend/app/services/ai_quality.py backend/app/schemas/ai.py backend/tests/ai_infra/test_registry_and_metrics.py
    git commit -m "feat(ai): expose operational skill quality metrics"

---

### Task 8: Present the New Indicators in the Existing Diagnostics UI

**Files:**
- Create: frontend/src/components/ai/AiQualityMetricsModel.test.ts
- Modify: frontend/src/api/types.ts
- Modify: frontend/src/components/ai/AiQualityMetricsModel.ts
- Modify: frontend/src/components/ai/AiQualityDiagnosticsCard.tsx
- Modify: frontend/src/components/ai/AiQualityDiagnosticsModal.tsx
- Modify: frontend/src/components/ai/AiWorkspaceQualityDiagnostics.test.tsx
- Modify: frontend/src/components/ai/aiWorkspaceTestFixtures.ts

**Interfaces:**
- Consumes: backend operational_metrics.
- Produces: compact first-pass, continuation, and approval-unedited indicators with empty-denominator states.

- [ ] **Step 1: Write failing model and rendering tests**

    expect(formatAiRate({ numerator: 4, denominator: 5, rate: 0.8 })).toBe('80%（4/5）')
    expect(formatAiRate({ numerator: 0, denominator: 0, rate: null })).toBe('暂无样本')

Render assertions:

    expect(screen.getByText('草稿一次通过')).toBeInTheDocument()
    expect(screen.getByText('80%（4/5）')).toBeInTheDocument()
    expect(screen.getByText('跨步骤完成')).toBeInTheDocument()
    expect(screen.getByText('确认时未修改')).toBeInTheDocument()
    expect(screen.getByText('工具预算耗尽 1 次')).toBeInTheDocument()

- [ ] **Step 2: Run tests and confirm type or rendering failures**

Run:

    npm --prefix frontend run test -- AiQualityMetricsModel AiWorkspaceQualityDiagnostics

Expected: operational_metrics is missing from types and UI.

- [ ] **Step 3: Add types and pure formatting helpers**

Add:

    export interface AiRateMetric {
      numerator: number;
      denominator: number;
      rate: number | null;
    }

    export function formatAiRate(metric?: AiRateMetric | null) {
      if (!metric || !metric.denominator || metric.rate == null) return '暂无样本';
      return Math.round(metric.rate * 100) + '%（' + metric.numerator + '/' + metric.denominator + '）';
    }

Extend AiQualityMetrics with operational_metrics and update the shared fixture so all existing workspace tests keep compiling.

- [ ] **Step 4: Render indicators without overclaiming**

Card order:

1. 运行成功率.
2. 草稿一次通过.
3. 跨步骤完成.
4. 确认时未修改.

The modal additionally lists invalid identity rejections, continuation rejections, and Tool budget exhaustion counts. Add explanatory copy that these numbers describe recent AI workflow behavior and do not measure recommendation correctness.

- [ ] **Step 5: Run frontend tests and build**

Run:

    npm --prefix frontend run test -- AiQualityMetricsModel AiWorkspaceQualityDiagnostics AiWorkspace
    npm --prefix frontend run build

Expected: model, diagnostics, workspace tests, typecheck, and bundle budget pass.

- [ ] **Step 6: Commit**

    git add frontend/src/api/types.ts frontend/src/components/ai/AiQualityMetricsModel.ts frontend/src/components/ai/AiQualityMetricsModel.test.ts frontend/src/components/ai/AiQualityDiagnosticsCard.tsx frontend/src/components/ai/AiQualityDiagnosticsModal.tsx frontend/src/components/ai/AiWorkspaceQualityDiagnostics.test.tsx frontend/src/components/ai/aiWorkspaceTestFixtures.ts
    git commit -m "feat(ai): show skill quality indicators"

---

### Task 9: Add the Deterministic CI Gate and Release Rules

**Files:**
- Modify: .github/workflows/quality-gates.yml
- Modify: docs/ai-assistant-standards.md
- Modify: package.json

**Interfaces:**
- Blocks: contract or invariant regressions in the scripted 32-case suite.
- Does not block: real-provider semantic score fluctuations.

- [ ] **Step 1: Add the dedicated GitHub Actions job**

Add ai-skill-evals with the same Python 3.12 setup as backend-ai:

    ai-skill-evals:
      name: AI Skill Evaluation Gate
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with:
            python-version: '3.12'
        - name: Install backend dependencies
          run: |
            python -m venv backend/.venv
            backend/.venv/bin/python -m pip install --upgrade pip
            backend/.venv/bin/python -m pip install -r backend/requirements.txt
        - name: Run deterministic AI skill evaluations
          env:
            CULINA_AI_EVAL_REPORT_PATH: .artifacts/ai-skill-eval-report.json
          run: npm run backend:test:ai-evals
        - name: Check AI skill thresholds
          run: npm run backend:check:ai-evals
        - name: Upload AI skill report
          if: always()
          uses: actions/upload-artifact@v4
          with:
            name: ai-skill-eval-report
            path: backend/.artifacts/ai-skill-eval-report.json

- [ ] **Step 2: Document ownership and baseline change rules**

docs/ai-assistant-standards.md must require:

- Every new Skill, Tool, handoff, draft type, or attachment policy adds or updates cases in the same PR.
- A case may change only with a reason recorded in the PR description.
- Lowering a threshold requires explicit reviewer approval and before/after report attachment.
- Real-provider observations use source = real_provider and are reviewed as trends; they do not replace the scripted gate.
- Eval data must remain synthetic and family-neutral.

- [ ] **Step 3: Run the complete Phase 4 verification**

Run:

    CULINA_AI_EVAL_REPORT_PATH=.artifacts/ai-skill-eval-report.json npm run backend:test:ai-evals
    npm run backend:check:ai-evals
    npm run backend:test:ai
    npm --prefix frontend run test
    npm --prefix frontend run build
    git diff --check

Expected: the 32-case report passes every committed threshold, all backend AI and frontend tests pass, the build succeeds, and the report contains no secrets or production identifiers.

- [ ] **Step 4: Inspect the generated report before commit**

Run:

    backend/.venv/bin/python -c "import json; p='backend/.artifacts/ai-skill-eval-report.json'; d=json.load(open(p)); print(d['schemaVersion'], d['source'], d['caseCount'], d['invalidIdentityWriteCount']); print({k:v['rate'] for k,v in d['metrics'].items()})"

Expected: skill_eval_report.v1, scripted, 32, 0, followed by rates meeting backend/ai_eval_thresholds.json.

- [ ] **Step 5: Commit**

    git add .github/workflows/quality-gates.yml docs/ai-assistant-standards.md package.json
    git commit -m "ci(ai): gate skill contract quality"

---

## Phase Exit Criteria

- The 32-case synthetic dataset validates all nine Skills and every Phase 3 continuation edge.
- Scripted cases exercise the real loader, registry, draft validation, approval pause, and continuation validation without network access.
- Reports expose exact numerators, denominators, rates, case failures, and invalid-write count.
- CI blocks deterministic routing, Tool, terminal, draft, continuation, or family-identity contract regressions.
- Real-provider semantic observations share the report schema but remain non-blocking.
- Online diagnostics show first-pass draft, continuation completion, approval-unedited, invalid-identity rejection, and budget-exhaustion indicators for the current family only.
- No new analytics table, provider call, sensitive fixture, or production ID is introduced.
- The full verification command is green and each task has an independent commit.
