import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FoodWorkspace plan overlay ownership', () => {
  it('delegates plan create and detail overlays to the focused plan view', () => {
    const workspace = readFileSync(resolve(__dirname, 'FoodWorkspace.tsx'), 'utf8');
    const overlays = readFileSync(resolve(__dirname, 'FoodWorkspacePlanOverlays.tsx'), 'utf8');
    expect(workspace).toContain('<FoodWorkspacePlanOverlays');
    expect(workspace).not.toContain('<FoodPlanDialog');
    expect(workspace).not.toContain('<FoodPlanDetailWithCandidates');
    expect(overlays).toContain('export function FoodWorkspacePlanOverlays');
    expect(overlays).toContain('completePlanItem');
  });
});
