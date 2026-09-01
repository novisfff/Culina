import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop shell responsive styles', () => {
  it('fully collapses the sidebar without loading an individual workspace route', () => {
    const styles = readFileSync(resolve(__dirname, 'shell-responsive.css'), 'utf8');

    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-label,[\s\S]*?visibility:\s*hidden;/);
    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-family\s*\{[\s\S]*?max-width:\s*0;/);
    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-nav-item\s*\{[\s\S]*?width:\s*44px;/);
    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-user-card\s*\{[\s\S]*?width:\s*44px;/);
  });
});
