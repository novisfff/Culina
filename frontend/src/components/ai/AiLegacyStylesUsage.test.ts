import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const srcRoot = resolve(repoRoot, 'src');

const staleAiClasses = [
  'ai-debug-exchanges',
  'ai-debug-response-text',
  'ai-editor-grid',
  'ai-editor-section',
  'ai-ingredient-row',
  'ai-retry-action',
  'ai-run-activity-dot',
  'ai-select-option-mark',
  'ai-step-row',
];

function collectNonTestSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      return collectNonTestSourceFiles(path);
    }

    if (!stats.isFile()) {
      return [];
    }

    if (!/\.(css|ts|tsx)$/.test(path) || /\.test\.(ts|tsx)$/.test(path)) {
      return [];
    }

    return [path];
  });
}

describe('AI legacy style cleanup', () => {
  it('loads shared AI Draft styles from the dedicated stylesheet', () => {
    const entry = readFileSync(resolve(repoRoot, 'src/styles.css'), 'utf8');
    const draftStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-draft-ui.css'), 'utf8');

    expect(entry).toContain("@import './styles/09-ai-draft-ui.css';");
    expect(draftStyles).toContain('.ai-draft-summary-card');
    expect(draftStyles).toContain('.ai-draft-section');
  });

  it('keeps AI styles free of stale pre-ui-kit helper classes', () => {
    const sourceByFile = collectNonTestSourceFiles(srcRoot).map((path) => ({
      label: relative(repoRoot, path),
      source: readFileSync(path, 'utf8'),
    }));

    for (const className of staleAiClasses) {
      const matches = sourceByFile
        .filter(({ source }) => source.includes(className))
        .map(({ label }) => label);

      expect(matches, `${className} is still referenced in ${matches.join(', ')}`).toEqual([]);
    }
  });

  it('keeps AI welcome prompt styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');
    const styleEntrypoint = readFileSync(resolve(repoRoot, 'src/styles.css'), 'utf8');

    expect(aiStyles).toContain('.ai-welcome-card');
    expect(aiStyles).toContain('.ai-suggestion-grid-card');
    expect(styleEntrypoint).toContain("@import './styles/09-ai-workspace.css';");
    expect(foodStyles).not.toContain('.ai-welcome-card');
    expect(foodStyles).not.toContain('.ai-suggestion-grid-card');
    expect(foodStyles).not.toContain('.ai-empty-prompt');
  });

  it('keeps AI dialog and approval field styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-delete-confirm-modal.workspace-modal');
    expect(aiStyles).toContain('.ai-rating-field .ui-star-rating-input');
    expect(foodStyles).not.toContain('.ai-delete-confirm-modal');
    expect(foodStyles).not.toContain('.ai-delete-confirm-actions');
    expect(foodStyles).not.toContain('.ai-rating-field');
  });

  it('keeps AI debug drawer styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-debug-drawer-root');
    expect(aiStyles).toContain('.ai-debug-tool-grid');
    expect(foodStyles).not.toContain('.ai-debug-drawer-root');
    expect(foodStyles).not.toContain('.ai-debug-tabs');
    expect(foodStyles).not.toContain('.ai-debug-error-card');
    expect(foodStyles).not.toContain('.ai-debug-tool-grid');
  });

  it('keeps AI result card and query result styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-result-card');
    expect(aiStyles).toContain('.ai-query-result-card');
    expect(aiStyles).toContain('.ai-operation-result-footer');
    expect(aiStyles).toContain('.ai-clarification-options');
    expect(aiStyles).toContain('.ai-recommendation-plan-modal');
    expect(aiStyles).toContain('.ai-plan-feedback');
    expect(foodStyles).not.toContain('ai-result-card');
    expect(foodStyles).not.toContain('ai-query-');
    expect(foodStyles).not.toContain('ai-operation-result');
    expect(foodStyles).not.toContain('ai-clarification-');
    expect(foodStyles).not.toContain('ai-recommendation-plan');
    expect(foodStyles).not.toContain('ai-plan-feedback');
  });

  it('keeps AI approval panel shell styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-approval-panel');
    expect(aiStyles).toContain('.ai-approval-head');
    expect(aiStyles).toContain('.ai-approval-status');
    expect(aiStyles).toContain('.ai-approval-actions');
    expect(aiStyles).toContain('.ai-human-input-request .ai-approval-panel');
    expect(foodStyles).not.toContain('.ai-approval-panel');
    expect(foodStyles).not.toContain('.ai-approval-head');
    expect(foodStyles).not.toContain('.ai-approval-status');
    expect(foodStyles).not.toContain('.ai-approval-actions');
    expect(foodStyles).not.toContain('.ai-human-input-request .ai-approval');
  });

  it('keeps AI approval editor chrome styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-recipe-editor');
    expect(aiStyles).toContain('.ai-draft-editor-head');
    expect(aiStyles).toContain('.ai-approval-failure-summary');
    expect(aiStyles).toContain('.ai-composite-operation-editor');
    expect(aiStyles).toContain('.ai-composite-operation-summary-card');
    expect(aiStyles).toContain('.ai-meal-log-summary-card');
    expect(aiStyles).toContain('.ai-meal-log-reference-grid');
    expect(aiStyles).toContain('.ai-ingredient-profile-intent');
    expect(aiStyles).toContain('.ai-ingredient-profile-summary-card');
    expect(aiStyles).toContain('.ai-inline-unit-input');
    expect(aiStyles).toContain('.ai-recipe-summary-card');
    expect(aiStyles).toContain('.ai-recipe-cook-preview-card');
    expect(aiStyles).toContain('.ai-tag-preview');
    expect(aiStyles).toContain('.ai-food-profile-favorite-card');
    expect(aiStyles).toContain('.ai-inventory-operation-summary-card');
    expect(aiStyles).toContain('.ai-inventory-operation-main-row');
    expect(aiStyles).toContain('.ai-inventory-resolved-card');
    expect(aiStyles).toContain('.ai-confirmation-grid');
    expect(aiStyles).toContain('.ai-resource-field');
    expect(aiStyles).toContain('.ai-resource-select');
    expect(foodStyles).not.toContain('.ai-recipe-editor');
    expect(foodStyles).not.toContain('.ai-draft-editor-head');
    expect(foodStyles).not.toContain('.ai-approval-failure-summary');
    expect(foodStyles).not.toContain('ai-composite');
    expect(foodStyles).not.toContain('ai-meal-log');
    expect(foodStyles).not.toContain('ai-ingredient-profile');
    expect(foodStyles).not.toContain('ai-inline-unit-input');
    expect(foodStyles).not.toContain('ai-recipe');
    expect(foodStyles).not.toContain('ai-tag-preview');
    expect(foodStyles).not.toContain('ai-confirmation-title-input');
    expect(foodStyles).not.toContain('ai-draft-remove-button');
    expect(foodStyles).not.toContain('ai-food-profile-favorite-card');
    expect(foodStyles).not.toContain('ai-inventory-operation');
    expect(foodStyles).not.toContain('ai-inventory-');
    expect(foodStyles).not.toContain('ai-resource-inputs-flex');
    expect(foodStyles).not.toContain('.ai-confirmation-grid');
    expect(foodStyles).not.toContain('\n.ai-resource-field {');
    expect(foodStyles).not.toContain('\n.ai-resource-select {');
  });

  it('keeps AI meal plan draft styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-meal-plan-summary-card');
    expect(aiStyles).toContain('.ai-meal-plan-ingredient-row');
    expect(aiStyles).toContain('.ai-ingredient-quantity-control');
    expect(foodStyles).not.toContain('ai-meal-plan');
    expect(foodStyles).not.toContain('ai-ingredient-quantity-control');
    expect(foodStyles).not.toContain('ai-ingredient-unit-combobox');
    expect(foodStyles).not.toContain('ai-ingredient-remove-button');
  });

  it('keeps AI shopping list and food profile draft styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-shopping-list-summary-card');
    expect(aiStyles).toContain('.ai-shopping-list-card-head');
    expect(aiStyles).toContain('.ai-shopping-list-before-after');
    expect(aiStyles).toContain('.ai-food-profile-summary-card');
    expect(aiStyles).toContain('.ai-food-profile-section');
    expect(aiStyles).toContain('.ai-food-profile-tag-presets');
    expect(foodStyles).not.toContain('ai-shopping-list');
    expect(foodStyles).not.toContain('ai-food-profile');
  });

  it('keeps AI desktop shell and thread base styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-side-head');
    expect(aiStyles).toContain('.ai-quality-card');
    expect(aiStyles).toContain('.ai-history-waiting-icon');
    expect(aiStyles).toContain('.ai-conversation-manage');
    expect(aiStyles).toContain('.ai-history-shared-badge');
    expect(aiStyles).toContain('.ai-thread-follow-button');
    expect(aiStyles).toContain('.ai-message-avatar');
    expect(aiStyles).toContain('.ai-draft-generating-cue');
    expect(foodStyles).not.toContain('ai-quality-card');
    expect(foodStyles).not.toContain('ai-side-head');
    expect(foodStyles).not.toContain('ai-history-waiting-icon');
    expect(foodStyles).not.toContain('ai-conversation-manage');
    expect(foodStyles).not.toContain('\n.ai-thread-follow-button {');
    expect(foodStyles).not.toContain('\n.ai-message-avatar {');
    expect(foodStyles).not.toContain('ai-draft-generating-cue');
  });

  it('keeps AI mobile, composer media, voice, and message action styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiStyles).toContain('.ai-mobile-title');
    expect(aiStyles).toContain('.ai-mobile-history-panel');
    expect(aiStyles).toContain('.ai-composer-attachment');
    expect(aiStyles).toContain('.ai-voice-input-button');
    expect(aiStyles).toContain('.ai-message-image-grid');
    expect(aiStyles).toContain('.ai-code-block-container');
    expect(aiStyles).toContain('.ai-message-actions-bar');
    expect(foodStyles).not.toContain('ai-mobile-title');
    expect(foodStyles).not.toContain('ai-mobile-history-panel');
    expect(foodStyles).not.toContain('ai-composer-attachment');
    expect(foodStyles).not.toContain('ai-voice-input-button');
    expect(foodStyles).not.toContain('ai-message-image-grid');
    expect(foodStyles).not.toContain('ai-code-block-container');
    expect(foodStyles).not.toContain('ai-message-actions-bar');
    expect(foodStyles).not.toContain('ai-sidebar-toggle-btn');
    expect(foodStyles).not.toContain('ai-history-group-title');
  });

  it('keeps the food workspace stylesheet free of AI-prefixed selectors', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).not.toMatch(/(^|\s)\.ai-[A-Za-z0-9_-]+/);
  });
});
