import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyChangedFiles, GATE_KEYS, MYSQL_SUITE_NAMES } from './classify-pr-gates.mjs';
import { runFrontendDomainTests } from './run-frontend-domain-tests.mjs';
import { verifyGateResults } from './verify-pr-gates.mjs';
import { buildAuditReport } from './audit-pr-gate-classification.mjs';

describe('classifyChangedFiles', () => {
  it('skips business gates for documentation-only changes', () => {
    const result = classifyChangedFiles(['AGENTS.md', 'docs/frontend-code-standards.md']);
    assert.equal(result.docsOnly, true);
    assert.equal(result.full, false);
    assert.equal(Object.values(result.gates).every((selected) => !selected), true);
  });

  it('treats runtime Skill Markdown as executable input', () => {
    for (const name of ['SKILL.md', 'references/workflows.md']) {
      const result = classifyChangedFiles([`backend/app/ai/skills/catalog/shopping-list/${name}`]);
      assert.equal(result.docsOnly, false);
      assert.equal(result.gates.backend_ai, true);
      assert.equal(result.gates.ai_evals, true);
    }
  });

  it('selects AI evaluations, contracts and database consumers from backend boundaries', () => {
    const tool = classifyChangedFiles(['backend/app/ai/tools/catalog/shopping.py']);
    assert.equal(tool.gates.ai_evals, true);
    const schema = classifyChangedFiles(['backend/app/schemas/ai.py']);
    assert.equal(schema.gates.frontend_ai_contract, true);
    const repo = classifyChangedFiles(['backend/app/repos/ai_operations.py']);
    assert.equal(repo.gates.backend_ai, true);
    const transactions = classifyChangedFiles(['backend/app/db/transactions.py']);
    for (const gate of ['backend_service', 'backend_ai', 'backend_search', 'backend_mysql']) {
      assert.equal(transactions.gates[gate], true, gate);
    }
  });

  it('keeps domain tests when CSS is added and keeps style-only scopes empty', () => {
    for (const name of ['InventoryActionDialog.tsx', 'inventoryActionModel.ts']) {
      const component = `frontend/src/features/inventory/${name}`;
      const css = 'frontend/src/styles/10-inventory-actions.css';
      for (const files of [[component, css], [css, component]]) {
        const result = classifyChangedFiles(files);
        assert.equal(result.gates.frontend_focus, true);
        assert.equal(result.gates.frontend_full, false);
        assert.equal(result.gates.frontend_e2e, true);
        assert.deepEqual(result.frontendScopes, ['src/features/inventory']);
      }
    }
    const styles = classifyChangedFiles(['frontend/src/styles/10-inventory-actions.css']);
    assert.equal(styles.gates.frontend_focus, false);
    assert.deepEqual(styles.frontendScopes, []);
  });

  it('selects real database tests for business and AI changes', () => {
    for (const path of [
      'backend/tests/inventory/test_inventory_mysql_concurrency.py',
      'backend/tests/account/test_auth_mysql_concurrency.py',
      'backend/tests/ai_infra/test_human_input_resume_mysql_concurrency.py',
      'backend/app/ai/workflows/runner.py',
    ]) {
      assert.equal(classifyChangedFiles([path]).gates.backend_mysql, true, path);
    }
  });

  it('selects the related frontend domain and typecheck for a model change', () => {
    const result = classifyChangedFiles(['frontend/src/features/inventory/inventoryActionModel.ts']);
    assert.equal(result.risk, 'unit');
    assert.deepEqual(result.frontendScopes, ['src/features/inventory']);
    assert.equal(result.gates.frontend_focus, true);
    assert.equal(result.gates.frontend_typecheck, true);
    assert.equal(result.gates.frontend_build, false);
  });

  it('adds build for a page/state change without escalating to full frontend tests', () => {
    const result = classifyChangedFiles(['frontend/src/components/ingredients/IngredientWorkspace.tsx']);
    assert.equal(result.risk, 'page');
    assert.equal(result.gates.frontend_focus, true);
    assert.equal(result.gates.frontend_typecheck, true);
    assert.equal(result.gates.frontend_build, true);
    assert.equal(result.gates.frontend_full, false);
  });

  it('adds the AI contract gate for AI workspace changes', () => {
    const result = classifyChangedFiles(['frontend/src/components/ai/AiWorkspace.tsx']);
    assert.equal(result.gates.frontend_ai_contract, true);
    assert.equal(result.gates.frontend_build, true);
    assert.equal(result.domains.includes('frontend'), true);
  });

  it('treats AI API and evaluation changes as contract/evaluation work', () => {
    const frontend = classifyChangedFiles(['frontend/src/api/aiApi.ts']);
    assert.equal(frontend.gates.frontend_ai_contract, true);
    assert.equal(frontend.gates.frontend_typecheck, true);

    const backend = classifyChangedFiles(['backend/app/ai/evals/scoring.py']);
    assert.equal(backend.gates.backend_ai, true);
    assert.equal(backend.gates.ai_evals, true);
  });

  it('selects backend search tests without unrelated frontend gates', () => {
    const result = classifyChangedFiles(['backend/app/services/search/indexing.py']);
    assert.equal(result.gates.backend_search, true);
    assert.equal(result.gates.backend_service, false);
    assert.equal(result.gates.frontend_build, false);
  });

  it('selects MySQL and migration gates for persistent model changes', () => {
    const result = classifyChangedFiles([
      'backend/app/models/domain.py',
      'backend/alembic/versions/123_add_column.py',
    ]);
    assert.equal(result.gates.backend_migration, true);
    assert.equal(result.gates.backend_service, true);
    assert.equal(result.gates.backend_mysql, true);

    const modelUsage = classifyChangedFiles(['backend/app/models/model_usage.py']);
    assert.equal(modelUsage.gates.backend_mysql, true);
    assert.equal(modelUsage.gates.backend_migration, true);
  });

  it('adds E2E for responsive or navigation changes', () => {
    const result = classifyChangedFiles(['frontend/src/styles/07-mobile.css']);
    assert.equal(result.gates.frontend_style, true);
    assert.equal(result.gates.frontend_e2e, true);
    assert.equal(result.gates.frontend_build, true);
    assert.equal(result.gates.frontend_focus, false);

    const api = classifyChangedFiles(['frontend/src/api/aiApi.ts']);
    assert.deepEqual(api.frontendScopes, ['src/api']);
  });

  it('keeps frontend-wide gates isolated from backend tests', () => {
    const uiKit = classifyChangedFiles(['frontend/src/components/ui-kit/PageLoadingState.tsx']);
    assert.equal(uiKit.full, true);
    assert.deepEqual(uiKit.domains, ['frontend']);
    assert.equal(uiKit.gates.frontend_full, true);
    assert.equal(Object.entries(uiKit.gates).some(([gate, selected]) => gate.startsWith('backend_') && selected), false);
    assert.equal(uiKit.gates.ai_evals, false);

    const globalStyles = classifyChangedFiles(['frontend/src/styles/00-ui-kit.css']);
    assert.equal(globalStyles.gates.frontend_full, true);
    assert.equal(globalStyles.gates.backend_service, false);
    assert.equal(globalStyles.gates.backend_migration, false);

    const multiScope = classifyChangedFiles([
      'frontend/src/features/inventory/InventoryWorkspace.tsx',
      'frontend/src/components/ingredients/IngredientWorkspace.tsx',
    ]);
    assert.equal(multiScope.full, true);
    assert.equal(multiScope.gates.frontend_full, true);
    assert.equal(Object.entries(multiScope.gates).some(([gate, selected]) => gate.startsWith('backend_') && selected), false);
    assert.equal(multiScope.gates.ai_evals, false);
  });

  it('fails closed for unknown and cross-domain changes', () => {
    const unknown = classifyChangedFiles(['scripts/release-something.sh']);
    assert.equal(unknown.full, true);
    assert.equal(unknown.gates.frontend_full, true);

    const crossDomain = classifyChangedFiles([
      'frontend/src/features/search/globalSearchModel.ts',
      'backend/app/services/search/indexing.py',
    ]);
    assert.equal(crossDomain.full, true);
    assert.equal(crossDomain.gates.frontend_focus, false);

    const crossFrontendDomain = classifyChangedFiles([
      'frontend/src/features/inventory/inventoryActionModel.ts',
      'frontend/src/components/ingredients/IngredientWorkspace.tsx',
    ]);
    assert.equal(crossFrontendDomain.full, true);
  });

  it('treats dependency manifests as runtime changes rather than documentation', () => {
    const result = classifyChangedFiles(['backend/requirements.txt']);
    assert.equal(result.docsOnly, false);
    assert.equal(result.full, true);
    assert.equal(result.domains.includes('backend-runtime'), true);
    assert.equal(result.gates.dependency_audit, true);
    assert.equal(result.gates.backend_service, true);

    const frontend = classifyChangedFiles(['frontend/package-lock.json']);
    assert.equal(frontend.full, true);
    assert.equal(frontend.gates.frontend_full, true);
    assert.equal(frontend.gates.dependency_audit, true);
    assert.equal(frontend.gates.backend_service, false);
    assert.equal(frontend.gates.backend_ai, false);
  });

  it('allows a full-gates label to override normal PR classification', () => {
    const result = classifyChangedFiles(['docs/frontend-code-standards.md'], { forceFull: true });
    assert.equal(result.full, true);
    assert.equal(result.docsOnly, false);
    assert.equal(result.gates.frontend_full, true);
    assert.match(result.reasons.at(-1), /full-gates/);
  });

  it('runs every gate for main pushes', () => {
    const result = classifyChangedFiles([], { eventName: 'push' });
    assert.equal(result.full, true);
    assert.equal(result.gates.frontend_focus, false);
    assert.equal(Object.entries(result.gates).every(([gate, selected]) => gate === 'frontend_focus' || selected), true);
    assert.deepEqual([...result.mysqlSuites].sort(), [...MYSQL_SUITE_NAMES].sort());
  });

  it('selects coarse MySQL suites with shared boundary escalation', () => {
    const service = classifyChangedFiles(['backend/app/api/inventory.py']);
    assert.deepEqual(service.mysqlSuites, ['service-concurrency']);
    const settings = classifyChangedFiles(['backend/app/services/family_model_settings/connection_tests.py']);
    assert.deepEqual(settings.mysqlSuites, ['family-model-settings', 'model-usage-core', 'model-usage-reporting']);
    const reporting = classifyChangedFiles(['backend/app/repos/model_usage/reporting.py']);
    assert.ok(reporting.mysqlSuites.includes('model-usage-reporting'));
    const shared = classifyChangedFiles(['backend/app/core/config.py']);
    assert.deepEqual([...shared.mysqlSuites].sort(), [...MYSQL_SUITE_NAMES].sort());
  });
});

describe('runFrontendDomainTests', () => {
  it('invokes Vitest with only the selected domain scopes', () => {
    const calls = [];
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };
    const result = runFrontendDomainTests({ scopesValue: '["src/lib", "src/features/inventory"]', spawn });
    assert.deepEqual(calls, [['npm', ['run', 'frontend:test', '--', 'src/lib', 'src/features/inventory'], { stdio: 'inherit' }]]);
    assert.equal(result.status, 0);
  });
});

describe('verifyGateResults', () => {
  it('blocks every selected matrix/gate on failure, cancellation, missing results or unexpected skip', () => {
    const env = { CLASSIFY_RESULT: 'success' };
    for (const gate of GATE_KEYS) {
      env[`REQUIRE_${gate.toUpperCase()}`] = 'true';
      env[`RESULT_${gate.toUpperCase()}`] = 'success';
    }
    assert.doesNotThrow(() => verifyGateResults(env));
    for (const gate of GATE_KEYS) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        assert.throws(() => verifyGateResults({ ...env, [`RESULT_${gate.toUpperCase()}`]: result }), new RegExp(gate));
      }
      assert.throws(() => verifyGateResults({ ...env, [`REQUIRE_${gate.toUpperCase()}`]: '' }), /classification requirement/);
    }
  });

  it('passes when selected jobs succeed and unselected jobs are skipped', () => {
    const env = { CLASSIFY_RESULT: 'success' };
    const selected = new Set(['frontend_focus', 'frontend_typecheck']);
    for (const gate of ['frontend_focus', 'frontend_typecheck', 'frontend_full', 'frontend_style', 'frontend_build', 'frontend_e2e', 'frontend_ai_contract', 'frontend_governance', 'backend_service', 'backend_ai', 'ai_evals', 'backend_search', 'backend_mysql', 'backend_migration', 'dependency_audit', 'deployment_smokes']) {
      env[`REQUIRE_${gate.toUpperCase()}`] = String(selected.has(gate));
      env[`RESULT_${gate.toUpperCase()}`] = selected.has(gate) ? 'success' : 'skipped';
    }
    assert.doesNotThrow(() => verifyGateResults(env));
  });

  it('fails when a selected job fails or the classifier fails', () => {
    const env = {
      CLASSIFY_RESULT: 'failure',
      REQUIRE_FRONTEND_BUILD: 'true',
      RESULT_FRONTEND_BUILD: 'failure',
    };
    assert.throws(() => verifyGateResults(env), /PR Gate failed/);
  });
});

describe('buildAuditReport', () => {
  it('reports full and unknown classifications without turning them into failures', () => {
    const report = buildAuditReport({
      risk: 'full',
      full: true,
      domains: [],
      changedFiles: ['scripts/release.sh'],
      gates: { frontend_full: true },
      reasons: ['未知路径 scripts/release.sh 无法安全分类'],
    });
    assert.match(report, /需关注（不阻断）/);
    assert.match(report, /未知路径/);
    assert.match(report, /不改变 PR Gate 结论/);
  });
});
