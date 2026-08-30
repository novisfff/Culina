import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App inventory maintenance composition ownership', () => {
  it('keeps dialog prop wiring in the app controller builder', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const controllerSource = readFileSync(resolve(__dirname, 'useAppInventoryMaintenanceDialogProps.ts'), 'utf8');

    expect(appSource).toContain('useAppInventoryMaintenanceDialogProps');
    expect(appSource).not.toContain('const inventoryMaintenanceDialogProps:');
    expect(controllerSource).toContain('export function useAppInventoryMaintenanceDialogProps');
    expect(controllerSource).toContain('shoppingIntake:');
    expect(controllerSource).toContain('reconciliation:');
    expect(controllerSource).toContain('operationHistory:');
  });
});
