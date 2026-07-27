# Playwright P0 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a deterministic, blocking Playwright Test P0 gate with visual regression, traces, and HTML reports while keeping the legacy full smoke suite available during gradual migration.

**Architecture:** Keep `frontend/scripts/smoke.mjs` as the complete legacy regression suite, but make its existing API mock installer import-safe so standard Playwright fixtures can reuse the same complete mock contract. Add focused P0 specs under `frontend/e2e/`, run them across representative phone, tablet, and desktop projects, and make that small suite blocking in CI. Keep the legacy smoke job non-blocking until the remaining scenarios are migrated and CI history demonstrates stability.

**Tech Stack:** Playwright Test 1.60, Chromium, JavaScript ESM, Vite preview, GitHub Actions.

## Global Constraints

- Base all work on `main` inside `/Users/zyf/IdeaProjects/Culina/.worktrees/playwright-p0-migration`.
- Do not change production UI, CSS, API contracts, or backend behavior.
- Reuse the complete API fixtures already owned by `frontend/scripts/smoke.mjs`; do not introduce a second partial mock universe.
- Run P0 on 375×812 phone, 1180×820 tablet, and 1440×960 desktop projects.
- Retain failure screenshots, video, and Trace; generate an HTML report on every run.
- Visual baselines change only through an explicit update command and remain reviewable in Git.
- Keep the legacy full smoke job non-blocking during migration; the new focused P0 job is the blocking regression gate.

---

### Task 1: Make the legacy smoke mock boundary import-safe

**Files:**
- Create: `frontend/scripts/smoke-module-boundary.test.mjs`
- Modify: `frontend/scripts/smoke.mjs`

**Interfaces:**
- Produces: named export `installApiMocks(context, unexpectedRequests, options?)`
- Preserves: direct `node scripts/smoke.mjs` execution and all existing environment-specific smoke modes

- [ ] **Step 1: Write the failing import-boundary test**

```js
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('legacy smoke module boundary', () => {
  it('can be imported without starting the legacy suite and exports its API mock installer', () => {
    const smokeUrl = new URL('./smoke.mjs', import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module = await import(${JSON.stringify(smokeUrl)});
         process.exit(typeof module.installApiMocks === 'function' ? 0 : 2);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.error, `${probe.stdout}\n${probe.stderr}`).toBeUndefined();
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing export fails**

Run: `npm --prefix frontend test -- scripts/smoke-module-boundary.test.mjs`

Expected: FAIL because importing the current script does not expose `installApiMocks`.

- [ ] **Step 3: Add a direct-execution guard and named export**

```js
const isDirectExecution =
  Boolean(process.argv[1])
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

export { installApiMocks };

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the boundary test and legacy smoke**

Run: `npm --prefix frontend test -- scripts/smoke-module-boundary.test.mjs`

Expected: PASS.

Run: `npm run frontend:smoke`

Expected: PASS with the existing complete smoke summary.

### Task 2: Add the standard Playwright Test P0 suite and visual baselines

**Files:**
- Create: `frontend/playwright.config.mjs`
- Create: `frontend/e2e/fixtures/p0App.mjs`
- Create: `frontend/e2e/p0-critical-journeys.spec.mjs`
- Create: `frontend/e2e/__screenshots__/p0-critical-journeys.spec.mjs/*.png`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run frontend:e2e:p0`
- Produces: `npm --prefix frontend run e2e:p0:update`
- Consumes: `installApiMocks` from Task 1

- [ ] **Step 1: Add the Playwright Test dependency and scripts**

Run: `npm install --prefix frontend --save-dev --save-exact @playwright/test@1.60.0`

Add frontend scripts:

```json
"e2e:p0": "playwright test --grep @p0",
"e2e:p0:update": "playwright test --grep @p0 --update-snapshots"
```

Add the root forwarding script:

```json
"frontend:e2e:p0": "npm --prefix frontend run e2e:p0 --"
```

- [ ] **Step 2: Add a runner config that lists no tests yet**

Configure `testDir`, representative Chromium projects, `webServer`, HTML and line reporters, `trace: "retain-on-failure"`, `screenshot: "only-on-failure"`, `video: "retain-on-failure"`, and a stable cross-platform snapshot path.

Run: `npm run frontend:e2e:p0 -- --list`

Expected: exit 0 and zero discovered P0 tests.

- [ ] **Step 3: Write the P0 fixture and behavior-first specs**

The fixture must:

```js
await installApiMocks(context, unexpectedRequests, { requestedApiPaths });
await context.addInitScript(() => {
  localStorage.setItem('culina-access-token', 'smoke-token');
  localStorage.setItem(
    'culina-navigation-v2',
    JSON.stringify({
      version: 2,
      primaryTab: 'home',
      eatBaseView: 'discover',
      discoverSection: 'all',
    }),
  );
});
```

After each test it must fail on unhandled API requests, page exceptions, or relevant browser console errors.

The specs must verify:

- unauthenticated login entry and horizontal overflow;
- authenticated home questions and activity highlight request;
- navigation to Food and Ingredient workspaces;
- navigation to meal history and opening the meal composer;
- visible `确认时间`, `添加食物`, and food search results;
- phone, tablet, and desktop layout through Playwright projects;
- login screenshots across all three representative viewports; meal-composer visual coverage remains in legacy smoke until native Linux baselines are stable.

- [ ] **Step 4: Run P0 and verify missing screenshots fail**

Run: `npm run frontend:e2e:p0`

Expected: functional assertions pass, screenshot assertions report missing baselines.

- [ ] **Step 5: Generate and review visual baselines**

Run: `npm --prefix frontend run e2e:p0:update`

Expected: baselines are written for 375×812, 1180×820, and 1440×960.

Run: `npm run frontend:e2e:p0`

Expected: all P0 tests and visual comparisons pass without updating snapshots.

- [ ] **Step 6: Ignore generated reports but keep baselines tracked**

Add:

```gitignore
frontend/playwright-report/
frontend/test-results/
```

Do not ignore `frontend/e2e/__screenshots__/`.

Also extend Vitest's default exclusions with `e2e/**` so `frontend:quality` does not attempt to execute Playwright specs:

```ts
exclude: [...configDefaults.exclude, 'e2e/**'],
```

### Task 3: Add the blocking P0 CI gate and retain legacy observation

**Files:**
- Modify: `.github/workflows/quality-gates.yml`
- Create: `frontend/e2e/README.md`

**Interfaces:**
- Produces: blocking GitHub Actions job `frontend-e2e-p0`
- Preserves: non-blocking `frontend-smoke` legacy job

- [ ] **Step 1: Add the blocking P0 CI job**

The job must install frontend dependencies and Chromium, build the frontend, run `npm run frontend:e2e:p0`, and upload `frontend/playwright-report/` plus `frontend/test-results/` with `if: always()`.

The job must not use `continue-on-error`.

- [ ] **Step 2: Label the legacy job as non-blocking migration coverage**

Keep `continue-on-error: true` on the legacy full smoke job and rename its display name so branch protection can target the focused P0 job unambiguously.

- [ ] **Step 3: Document baseline updates and legacy-gate removal criteria**

Document:

- local commands and the three exact viewports;
- where HTML reports, traces, videos, and screenshots are written;
- baseline updates require explicit review;
- remove the legacy `continue-on-error` only after its remaining scenarios are migrated or it has at least 10 consecutive clean CI runs without retry-dependent passes.

### Task 4: Verify the complete migration increment

**Files:**
- Verify all files changed by Tasks 1–3

**Interfaces:**
- Consumes: all commands and artifacts created above
- Produces: fresh completion evidence

- [ ] **Step 1: Run targeted tests**

Run: `npm --prefix frontend test -- scripts/smoke-module-boundary.test.mjs`

Run: `npm run frontend:e2e:p0`

Expected: all targeted tests pass and screenshot comparisons are unchanged.

- [ ] **Step 2: Run full frontend validation**

Run: `npm run frontend:quality`

Run: `npm run frontend:build`

Expected: exit 0; style and bundle report-only warnings are reviewed separately.

- [ ] **Step 3: Run the legacy full smoke**

Run: `npm run frontend:smoke`

Expected: complete legacy smoke passes across its existing viewport matrix.

- [ ] **Step 4: Inspect artifacts and repository hygiene**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Expected: no whitespace errors, no generated report directories tracked, and only scoped migration files changed.
