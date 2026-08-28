import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Model Usage route style ownership', () => {
  it('keeps the domain stylesheet out of the global entrypoint', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const globalStyles = readFileSync(resolve(repoRoot, 'src/styles.css'), 'utf8');
    const routeStyles = readFileSync(resolve(repoRoot, 'src/features/model-usage/model-usage-route.css'), 'utf8');
    expect(globalStyles).not.toContain("@import './styles/14-model-usage.css' layer(domain);");
    expect(routeStyles).toContain("@import '../../styles/14-model-usage.css' layer(domain);");
  });
});
