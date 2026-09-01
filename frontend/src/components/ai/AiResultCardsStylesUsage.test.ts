import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AI result card entity links', () => {
  it('renders entity navigation as an inline text action instead of a native button', () => {
    const styles = readFileSync(resolve(__dirname, '../../styles/09-ai-workspace.css'), 'utf8');

    expect(styles).toMatch(/\.ai-entity-open-button\s*\{[\s\S]*?width:\s*fit-content;[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/);
    expect(styles).toMatch(/\.ai-operation-result-item-copy p\s*\{[\s\S]*?margin:\s*0;/);
  });
});
