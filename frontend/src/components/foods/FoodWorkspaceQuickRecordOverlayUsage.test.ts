import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FoodWorkspace quick-record overlay ownership', () => {
  it('delegates compact food recording to a focused overlay', () => {
    const workspace = readFileSync(resolve(__dirname, 'FoodWorkspace.tsx'), 'utf8');
    const overlay = readFileSync(resolve(__dirname, 'FoodWorkspaceQuickRecordOverlay.tsx'), 'utf8');
    expect(workspace).toContain('<FoodWorkspaceQuickRecordOverlay');
    expect(workspace).not.toContain('<MealQuickRecordView');
    expect(overlay).toContain('export function FoodWorkspaceQuickRecordOverlay');
    expect(overlay).toContain('onTargetChange');
  });
});
