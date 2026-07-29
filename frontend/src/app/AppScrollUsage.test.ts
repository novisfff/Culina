import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App workspace scroll reset', () => {
  it('resets the persistent app content scroller when navigation changes', () => {
    const source = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(source).toContain("document.querySelector<HTMLElement>('.app-content')");
    expect(source).toContain("appContent?.scrollTo({ top: 0, left: 0, behavior: 'auto' })");
  });
});
