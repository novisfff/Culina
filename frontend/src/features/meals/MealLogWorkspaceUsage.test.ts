import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MealLogWorkspace overlay reuse', () => {
  it('uses shared overlay components for meal log modals', () => {
    const source = readFileSync(resolve(__dirname, './MealLogWorkspace.tsx'), 'utf8');

    expect(source).toContain('MealEnrichmentModal');
    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).not.toContain('<div className="workspace-overlay-root"');
    expect(source).not.toContain('<div className="workspace-overlay-backdrop"');
  });

  it('does not keep the legacy meal enrichment inline footer', () => {
    const enrichmentSource = readFileSync(resolve(__dirname, './MealLogEnrichment.tsx'), 'utf8');
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    for (const className of ['meal-enrichment-footer', 'meal-enrichment-footer button']) {
      expect(enrichmentSource).not.toContain(className);
      expect(mealLogStyles).not.toContain(className);
    }
  });

  it('lets shared modal footers own meal log action layout', () => {
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    expect(mealLogStyles).toContain('.meal-log-preview-modal-actions button');
    expect(mealLogStyles).not.toContain('.meal-log-preview-modal-actions .ui-form-actions-row');
    expect(mealLogStyles).not.toContain('.meal-log-preview-modal-actions .ui-form-actions-spacer');
    expect(mealLogStyles).not.toContain('.meal-enrichment-actions .ui-form-actions-row');
    expect(mealLogStyles).not.toContain('.meal-enrichment-actions .ui-form-actions-spacer');
  });

  it('keeps meal photo lightbox transition styling in CSS', () => {
    const enrichmentSource = readFileSync(resolve(__dirname, './MealLogEnrichment.tsx'), 'utf8');
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    expect(enrichmentSource).not.toContain('transition: isDragging');
    expect(mealLogStyles).toContain('.meal-photo-lightbox-viewport img');
    expect(mealLogStyles).toContain('transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)');
    expect(mealLogStyles).toContain('.meal-photo-lightbox-viewport.grabbing img');
    expect(mealLogStyles).toContain('transition: none');
  });
});
