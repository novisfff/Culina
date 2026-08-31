import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyChangedFiles } from './classify-pr-gates.mjs';
import { runFrontendDomainTests } from './run-frontend-domain-tests.mjs';
import { verifyGateResults } from './verify-pr-gates.mjs';

describe('classifyChangedFiles', () => {
  it('skips business gates for documentation-only changes', () => {
    const result = classifyChangedFiles(['AGENTS.md', 'docs/frontend-code-standards.md']);
    assert.equal(result.docsOnly, true);
    assert.equal(result.full, false);
    assert.equal(Object.values(result.gates).every((selected) => !selected), true);
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
    assert.equal(result.gates.backend_mysql, false);

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
    assert.equal(result.gates.dependency_audit, true);
    assert.equal(result.gates.backend_service, true);
  });

  it('runs every gate for main pushes', () => {
    const result = classifyChangedFiles([], { eventName: 'push' });
    assert.equal(result.full, true);
    assert.equal(result.gates.frontend_focus, false);
    assert.equal(Object.entries(result.gates).every(([gate, selected]) => gate === 'frontend_focus' || selected), true);
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
  it('passes when selected jobs succeed and unselected jobs are skipped', () => {
    const env = { CLASSIFY_RESULT: 'success' };
    const selected = new Set(['frontend_focus', 'frontend_typecheck']);
    for (const gate of ['frontend_focus', 'frontend_typecheck', 'frontend_full', 'frontend_style', 'frontend_build', 'frontend_e2e', 'frontend_ai_contract', 'backend_service', 'backend_ai', 'ai_evals', 'backend_search', 'backend_mysql', 'backend_migration', 'dependency_audit', 'deployment_smokes']) {
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
