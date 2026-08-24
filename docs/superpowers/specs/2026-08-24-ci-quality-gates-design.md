# CI Quality Gate Completion Design

**Status:** Confirmed on 2026-08-24

## 1. Context

The current GitHub Actions workflow separates backend, AI, search, model-usage, frontend, and browser checks into understandable jobs, but several checks are incomplete or report-only:

- The backend CI command set omits `tests/meal_logs` and `tests/ai_audio`. It also has no durable guard that prevents a newly added top-level test directory from being forgotten later.
- The style-token drift script reports 50 existing matches and always exits successfully, so a pull request can add more drift without failing CI.
- Alembic has one current script head, `6a7b8c9d0e1f`, but CI does not prove that a clean MySQL 8.4 database can migrate to that head.
- A deployment-level WebSocket/nginx smoke test exists but is not executed by CI. Media authorization is covered by in-process tests, not through the Compose deployment boundary with MySQL, MinIO, the backend, and nginx running together.
- `npm audit --omit=dev` currently reports zero frontend production vulnerabilities. `pip-audit` reports 42 advisories across six packages in the current backend environment, including fixable findings and findings inherited from `python-jose`/`ecdsa`.

The clean local baseline before this work is 1,745 passing frontend tests and 2,114 passing backend tests with 69 environment-dependent skips. The full backend collection contains 2,183 tests.

## 2. Goals

This change will make the following checks blocking on pull requests and pushes to `main`:

1. Every existing backend test directory is executed by exactly one ordinary CI test group, with specialized evaluation behavior retained where needed.
2. Existing style-token drift is grandfathered, while every net increase by rule and CSS file fails.
3. A clean MySQL 8.4 database can migrate through the complete Alembic chain to the single declared head.
4. Compose-level media authorization and WebSocket reverse-proxy behavior are exercised with real containers.
5. Frontend and backend production dependency audits complete with no unaccepted known vulnerability.

The checks must be runnable locally through repository scripts, must exit nonzero on a failed assertion, and must not require production credentials or external AI providers.

## 3. Non-goals

- Bundle budgets remain report-only in this change. Existing budget thresholds and `check-bundle-budgets.mjs` behavior are not changed.
- No backup or restore tooling, workflow, or drill is added.
- Coverage percentage thresholds are not introduced.
- The deployment smoke does not contact a real AI, speech, image, rerank, embedding, or vector provider.
- Application behavior is not redesigned. Dependency compatibility fixes are limited to preserving the current authentication, media-ticket, API, and test contracts.

## 4. Chosen Architecture

### 4.1 Backend test-group manifest

A tracked backend test-group manifest will be the single source of truth for ordinary CI pytest partitioning. A small Python runner will:

- validate the manifest before executing a group;
- discover top-level directories under `backend/tests/` that contain `test_*.py` files;
- reject an unknown manifest path, a missing discovered directory, a directory assigned to more than one group, or a manifest directory without tests;
- execute pytest for the requested group with the current Python interpreter and forward any additional pytest arguments;
- return pytest's exact exit status.

The manifest partitions the current directories as follows:

| Group | Test directories |
| --- | --- |
| `service` | `account`, `activity`, `core`, `deployment`, `family`, `inventory`, `meal_logs`, `media`, `recipes`, `shopping` |
| `ai` | `ai_audio`, `ai_infra` |
| `ai_evals` | `ai_evals` |
| `family_model_settings` | `family_model_settings` |
| `model_usage` | `model_usage` |
| `search` | `search` |

The existing root npm command names remain stable, but they delegate to the manifest runner. The model-usage job continues to run `family_model_settings` and `model_usage` against MySQL 8.4. The AI evaluation job continues to create and validate its deterministic report after running the `ai_evals` group.

This structure fixes the current omissions and makes a future unassigned test directory fail every group before pytest begins.

### 4.2 Incremental style-token gate

The style-token scanner will retain the existing rule identifiers and add a tracked, versioned baseline. The baseline records the allowed match count for each `(rule id, relative CSS file)` pair. It does not rely on line numbers, which would create false positives whenever unrelated lines move.

Comparison semantics are:

- a current count equal to its baseline passes;
- a lower count passes and is reported as removable baseline debt;
- a higher count fails by the exact positive delta;
- a match in a new file has a baseline of zero and fails;
- a baseline entry for a missing rule or non-CSS path is rejected as invalid configuration.

There is no automatic baseline-update mode in the blocking command. An intentional baseline increase therefore requires a visible reviewable JSON change. The existing 50 findings remain allowed, but the command changes from a report to an incremental gate and stays part of `frontend:quality`.

Scanner logic will be separated from the CLI entry point so Vitest can verify equal, reduced, increased, new-file, and malformed-baseline behavior without modifying repository CSS.

### 4.3 Alembic smoke

A dedicated migration command and GitHub Actions job will use a clean MySQL 8.4 service. The command will:

1. load the Alembic script directory without connecting and assert that exactly one head exists;
2. run `upgrade head` against an empty database;
3. run `upgrade head` a second time to prove the terminal migration is safe to re-enter;
4. read the database's current Alembic revision and assert that it equals the script head.

The smoke is intentionally an empty-database upgrade test. It does not claim to validate every historical production data shape or every downgrade path.

### 4.4 Compose deployment smoke

One blocking deployment job will execute two isolated smoke drivers:

#### Media authorization smoke

A Compose test definition will run MySQL 8.4, MinIO, Qdrant, the real backend image, and the real nginx frontend image under a unique project name and test-only ports. The backend will migrate the clean database and bootstrap a synthetic owner. A guarded deployment fixture script will create a second synthetic household and owner only when an explicit smoke environment flag is present.

The driver will make requests through nginx and verify:

- the first household can log in and upload a small valid image;
- the first household can request a media capability URL and read the uploaded bytes through it;
- an unauthenticated request to the media access endpoint returns `401`;
- the second household receives `404` when requesting access to the first household's media ID;
- a raw nginx `/media/...` path does not bypass backend authorization;
- anonymous access to the corresponding MinIO bucket/object is denied.

All credentials, household IDs, media bytes, and ticket sentinels are synthetic. The fixture is idempotent inside its disposable database and is unavailable unless the explicit smoke flag is set.

#### WebSocket/nginx smoke

The existing echo-backend deployment smoke remains focused on the reverse-proxy boundary. CI will install Chromium, run the current browser exchange through nginx, validate the negotiated `culina-realtime` subprotocol, and retain the existing assertions that tokens are absent from URLs and nginx logs. It will not require a configured realtime model provider.

Both drivers use `finally` cleanup, remove their own containers and networks, and emit container status/log evidence on failure. Workflow timeouts prevent an unhealthy service from hanging indefinitely.

### 4.5 Production dependency audit

Backend runtime and development dependencies will be separated:

- `backend/requirements.txt` contains dependencies installed in the production image;
- `backend/requirements-dev.txt` includes the production file and adds pytest/coverage tooling used by local development and CI;
- the backend Dockerfile continues to install only `backend/requirements.txt`;
- local setup and backend test jobs install `backend/requirements-dev.txt`.

The production baseline will be brought to zero known findings rather than accepting a permanent vulnerability allowlist:

- FastAPI and its compatible Starlette release are upgraded together;
- `cryptography`, `python-multipart`, and Pillow are upgraded to releases covering the reported fixes;
- `python-jose[cryptography]` is replaced with PyJWT so the unfixable `ecdsa` dependency is removed;
- JWT decoding continues to require the current algorithm, audience, expiry, issued-at, subject, ticket type, and scope claims as applicable;
- existing authentication and access-ticket tests are adapted to the PyJWT API without weakening their assertions.

The blocking audit job runs:

- `npm audit --omit=dev --audit-level=high` against the frontend lockfile;
- a pinned CI installation of `pip-audit`, auditing only `backend/requirements.txt`.

The audit job does not use blanket `continue-on-error` or a permanent advisory ignore list. If an upstream advisory has no safe upgrade in the future, accepting it requires a separate, explicit design decision rather than silently weakening this gate.

## 5. Workflow Topology

The existing readable job separation is preserved. The workflow gains or changes these blocking checks:

- backend service and AI jobs use the validated manifest and therefore include `meal_logs`, `deployment`, and `ai_audio`;
- a frontend style-drift job installs frontend dependencies and runs the incremental scanner;
- an Alembic migration job uses a dedicated MySQL 8.4 service;
- a Compose deployment job runs media and WebSocket smoke drivers;
- a production dependency audit job runs both package-manager audits.

Existing frontend Vitest, frontend build, P0 browser tests, AI evaluation, search, family-model-settings, and model-usage checks remain. Bundle warnings emitted by the frontend build stay non-blocking by explicit scope decision.

## 6. Failure and Cleanup Semantics

- Every checker returns a nonzero exit status for an invalid configuration, failed assertion, failed subprocess, audit finding, or incomplete cleanup that could mask the primary result.
- Test-group validation runs before pytest so an omitted directory cannot be hidden by passing tests in other groups.
- Style failures print the file, rule, baseline count, current count, and delta.
- Migration failures print the declared heads and observed database revisions.
- Compose drivers preserve the primary failure, attempt cleanup unconditionally, and print sanitized service diagnostics when startup or an assertion fails.
- No workflow step uses `continue-on-error` for these gates.

## 7. Test and Verification Strategy

Implementation uses focused regression tests for repository tooling before changing the commands that consume it:

- Python tests cover valid and invalid test-group manifests and migration-head comparison behavior.
- Vitest covers style-baseline comparison and malformed baseline input.
- Existing auth, access-ticket, media, AI audio, and deployment tests cover the PyJWT migration and retained security contracts.
- A clean MySQL service proves the real migration chain.
- Disposable Compose projects prove the nginx/backend/MinIO and nginx/WebSocket boundaries.
- Fresh `npm audit` and `pip-audit` runs prove the production dependency baselines.
- Full frontend and backend quality commands run after focused checks to catch framework or dependency compatibility regressions.

No viewport-specific UI validation is required because this change does not alter rendered UI or responsive behavior. Playwright's deployment test uses its existing default desktop project only to exercise the browser WebSocket stack.

## 8. Acceptance Criteria

The work is accepted when all of the following are true:

- The manifest validator accounts for all 16 current top-level backend test directories containing test modules exactly once.
- CI executes `tests/meal_logs`, `tests/ai_audio`, and `tests/deployment`, and existing specialized suites retain their current environment/report behavior.
- The current 50 style-token matches pass, while automated tests prove that an added match fails.
- Alembic exposes one head and a clean MySQL 8.4 database reaches that exact revision through `upgrade head`.
- The Compose media smoke proves successful same-household capability access plus unauthenticated, cross-household, raw-path, and anonymous-MinIO denial.
- The WebSocket smoke runs in CI and preserves its subprotocol and log-redaction assertions.
- Frontend production audit reports zero applicable vulnerabilities at the configured threshold.
- Backend production audit reports zero known vulnerabilities without a permanent ignore list.
- Full frontend and backend quality commands pass after the dependency updates.
- Bundle-budget behavior and backup/restore scope are unchanged.
