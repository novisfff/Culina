import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mealsDir = resolve(__dirname);

function readSource(fileName: string) {
  return readFileSync(resolve(mealsDir, fileName), 'utf8');
}

const DEBT_LANGUAGE = ['待补充', '未完成', '欠缺资料', '记录任务'] as const;

describe('MealLogWorkspace overlay reuse', () => {
  it('uses shared overlay components for meal log modals', () => {
    const source = readSource('MealLogWorkspace.tsx');

    expect(source).toContain('MealEnrichmentModal');
    expect(source).toContain('MealHistorySurface');
    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).not.toContain('<div className="workspace-overlay-root"');
    expect(source).not.toContain('<div className="workspace-overlay-backdrop"');
  });

  it('keeps MealHistorySurface free of debt-task language', () => {
    const historySource = readSource('MealHistorySurface.tsx');
    const modelSource = readSource('MealLogWorkspaceModel.ts');
    const mobileSource = readSource('MealLogMobileView.tsx');
    const workspaceSource = readSource('MealLogWorkspace.tsx');
    const enrichmentModalSource = readSource('MealEnrichmentModal.tsx');

    expect(historySource).toContain('export function MealHistorySurface');
    for (const phrase of DEBT_LANGUAGE) {
      expect(historySource).not.toContain(phrase);
      expect(modelSource).not.toContain(phrase);
      expect(mobileSource).not.toContain(phrase);
      expect(workspaceSource).not.toContain(phrase);
      expect(enrichmentModalSource).not.toContain(phrase);
    }
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
