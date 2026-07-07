import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentSourcePath = resolve(__dirname, 'IngredientDestroyExpiredOverlay.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');
const mobileStylePath = resolve(__dirname, '../../styles/07-mobile.css');

describe('IngredientDestroyExpiredOverlay style usage', () => {
  it('uses the current row classes and does not keep stale destroy-expired item styles', () => {
    const componentSource = readFileSync(componentSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const mobileStyleSource = readFileSync(mobileStylePath, 'utf8');

    expect(componentSource).toContain('className="destroy-expired-row"');
    expect(componentSource).toContain('className="destroy-expired-row-main"');
    expect(componentSource).toContain('className="destroy-expired-row-meta"');
    expect(componentSource).not.toContain('destroy-expired-item');
    expect(ingredientsStyleSource).not.toContain('destroy-expired-item');
    expect(mobileStyleSource).not.toContain('destroy-expired-item');
  });
});
