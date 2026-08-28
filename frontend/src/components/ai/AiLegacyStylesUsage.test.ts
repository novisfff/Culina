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
    const aiWorkspaceStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');
    const mobileStyles = readFileSync(resolve(repoRoot, 'src/styles/07-mobile.css'), 'utf8');

    expect(entry).toContain("@import './styles/09-ai-draft-ui.css' layer(domain);");
    expect(draftStyles).toContain('.ai-draft-summary-card');
    expect(draftStyles).toContain('.ai-draft-section');
    expect(draftStyles).toContain('.ai-draft-impact-note');
    expect(draftStyles).toContain('.ai-draft-item-card');
    expect(draftStyles).toContain('.ai-draft-resolved-summary');
    expect(draftStyles).toContain('.ai-draft-editor-head');
    expect(draftStyles).toContain('.ai-draft-add-button');
    expect(draftStyles).toContain('.ai-confirmation-grid');
    expect(draftStyles).toContain('.ai-resource-field');
    expect(draftStyles).toContain('.ai-resource-select');
    expect(draftStyles).toMatch(/\.ai-draft-section \+ \.ai-draft-section\s*\{/);
    expect(draftStyles).toMatch(/\.ai-draft-item-card\.tone-danger\s*\{/);
    expect(draftStyles).toContain('.ai-draft-summary-card.ai-confirmation-item');
    expect(draftStyles).toContain('.ai-draft-section.ai-confirmation-item');
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-draft-editor-head\s*\{/m);
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-draft-add-button\s*\{/m);
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-confirmation-item\s*\{/m);
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-resource-field\s*\{/m);
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-resource-select\s*\{/m);
    expect(aiWorkspaceStyles).toContain('.ai-confirmation-item .compact-input');
    expect(mobileStyles).not.toContain('ai-confirmation-item');
  });

  it('keeps AI Draft single-line controls aligned without double-height comboboxes', () => {
    const draftStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-draft-ui.css'), 'utf8');

    expect(draftStyles).toContain('--ai-draft-control-height: var(--control-height);');
    expect(draftStyles).toContain('height: var(--ai-draft-control-height);');
    expect(draftStyles).toMatch(
      /\.ai-draft-field \.ui-combobox-field\.ai-resource-select > input\s*\{[^}]*min-height: 0;[^}]*height: 100%;/s,
    );
    expect(draftStyles).toContain('--ai-draft-control-height: var(--control-height-touch);');
    expect(draftStyles).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.ai-ingredient-profile-conversion-fields\s*\{[^}]*grid-template-columns: minmax\(0, 0\.9fr\) minmax\(0, 1\.1fr\);/,
    );
  });

  it('keeps semantic AI Draft polish styles with their owning layers', () => {
    const uiKitStyles = readFileSync(resolve(repoRoot, 'src/styles/00-ui-kit.css'), 'utf8');
    const draftStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-draft-ui.css'), 'utf8');
    const aiWorkspaceStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(uiKitStyles).toContain('.ui-searchable-resource-select-loading');
    expect(draftStyles).toContain('.ai-draft-resource-search.has-selected-resource');
    expect(draftStyles).toContain('.ai-draft-resource-list');
    expect(draftStyles).toMatch(
      /\.ai-draft-resource-select \.ai-draft-resource-list\.is-popover\s*\{[^}]*position: absolute;[^}]*z-index: 70;[^}]*width: 100%;[^}]*box-shadow: var\(--shadow-md\);/s,
    );
    expect(draftStyles).toMatch(
      /\.ai-draft-resource-list \.ui-searchable-resource-select-option-media \.ai-resource-thumbnail-frame[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/,
    );
    expect(draftStyles).toContain('.ai-draft-tag-editor');
    expect(draftStyles).toContain('.ai-meal-log-stock-header');
    expect(draftStyles).toContain('.ai-meal-plan-ingredient-actions');
    expect(draftStyles).toContain('fieldset.ai-inventory-intake-conversion');
    expect(aiWorkspaceStyles).toContain('.ai-inventory-intake-chevron-icon');
    expect(aiWorkspaceStyles).toContain('.ai-approval-brief-badges.draft-ingredient-profile');
  });

  it('keeps inventory intake disclosure rows as unified neutral cards', () => {
    const aiWorkspaceStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');

    expect(aiWorkspaceStyles).toMatch(
      /\.ai-inventory-intake-group-list\s*\{[^}]*gap: var\(--space-3\);[^}]*border: 0;/s,
    );
    expect(aiWorkspaceStyles).toMatch(
      /\.ai-inventory-intake-row\s*\{[^}]*border: 1px solid var\(--line-soft\);[^}]*border-radius: var\(--radius-sm\);[^}]*background: var\(--surface\);/s,
    );
    expect(aiWorkspaceStyles).toMatch(
      /\.ai-inventory-intake-row-body\s*\{[^}]*margin: 0;[^}]*border-top: 1px solid var\(--line-soft\);[^}]*background: var\(--surface-warm\);/s,
    );
    expect(aiWorkspaceStyles).not.toMatch(
      /\.ai-inventory-intake-row-body\s*\{[^}]*border-left:/s,
    );
    expect(aiWorkspaceStyles).toMatch(
      /\.ai-inventory-intake-row\.needs-attention\s*\{[^}]*border-color: var\(--warning-line\);/s,
    );
    expect(aiWorkspaceStyles).toMatch(
      /\.ai-inventory-intake-chevron-icon\s*\{[^}]*grid-column: 2;[^}]*grid-row: 1 \/ span 2;/s,
    );
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
    expect(styleEntrypoint).toContain("@import './styles/09-ai-workspace.css' layer(domain);");
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
    expect(aiStyles).toMatch(
      /\.ai-human-input-request \.ai-approval-panel\.is-human-input-resolved\s*\{[^}]*max-height: none;/s,
    );
    expect(aiStyles).not.toContain('max-height: 124px;');
    expect(foodStyles).not.toContain('.ai-approval-panel');
    expect(foodStyles).not.toContain('.ai-approval-head');
    expect(foodStyles).not.toContain('.ai-approval-status');
    expect(foodStyles).not.toContain('.ai-approval-actions');
    expect(foodStyles).not.toContain('.ai-human-input-request .ai-approval');
  });

  it('keeps AI approval editor chrome styles out of the food workspace stylesheet', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const aiStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-workspace.css'), 'utf8');
    const draftStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-draft-ui.css'), 'utf8');

    expect(aiStyles).toContain('.ai-recipe-editor');
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
    expect(draftStyles).toContain('.ai-draft-editor-head');
    expect(draftStyles).toContain('.ai-confirmation-grid');
    expect(draftStyles).toContain('.ai-resource-field');
    expect(draftStyles).toContain('.ai-resource-select');
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
