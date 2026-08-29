import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('inventory maintenance route styles', () => {
  it('loads inventory-only styles from the lazy overlay entry', () => {
    const repoRoot = resolve(__dirname, '../..');
    const globalStyles = readFileSync(resolve(repoRoot, 'styles.css'), 'utf8');
    const routeStyles = readFileSync(resolve(__dirname, 'inventory-route.css'), 'utf8');
    const entrySource = readFileSync(resolve(repoRoot, 'app/AppInventoryMaintenanceDialogs.tsx'), 'utf8');
    expect(globalStyles).toContain("@import './features/inventory/inventory-route.css' layer(domain);");
    expect(routeStyles).toContain("@import '../../styles/10-inventory-actions.css' layer(domain);");
    expect(routeStyles).toContain("@import '../../styles/11-inventory-maintenance.css' layer(domain);");
    expect(entrySource).toContain("./routeEntries/inventory");
  });
});
