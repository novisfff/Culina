import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App Eat task adapter ownership', () => {
  it('keeps task payload wiring behind typed ports', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const adapterSource = readFileSync(resolve(__dirname, 'useAppEatTaskBodyArgs.ts'), 'utf8');

    expect(appSource).toContain('useAppEatTaskBodyArgs');
    expect(appSource).not.toContain('taskBodyArgs={{');
    expect(adapterSource).toContain('export function useAppEatTaskBodyArgs');
    expect(adapterSource).toContain('pending:');
    expect(adapterSource).toContain('actions:');
  });
});
