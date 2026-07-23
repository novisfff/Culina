/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_MESSAGE_PART_TYPES,
  AI_MESSAGE_PART_RENDERERS,
  AI_RESULT_CARD_TYPES,
  AI_RESULT_CARD_RENDERERS,
} from './aiWorkspaceContracts';
import type { AiTaskDraftType } from '../api/types';

function readBackendLiteralValues(typeName: string) {
  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/app/schemas/ai.py');
  const source = readFileSync(schemaPath, 'utf8');
  const match = source.match(new RegExp(`${typeName}\\s*=\\s*Literal\\[([^\\]]+)\\]`));
  if (!match) {
    throw new Error(`Could not find backend Literal ${typeName}`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort();
}

function readFrontendDraftTypeValues() {
  const typesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../api/types.ts');
  const source = readFileSync(typesPath, 'utf8');
  const match = source.match(/export type AiTaskDraftType = ([^;]+);/);
  if (!match) {
    throw new Error('Could not find frontend AiTaskDraftType');
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1] as AiTaskDraftType).sort();
}

function readFrontendLiteralValues(typeName: string) {
  const typesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../api/types.ts');
  const source = readFileSync(typesPath, 'utf8');
  const match = source.match(new RegExp(`export type ${typeName} = ([^;]+);`));
  if (!match) {
    throw new Error(`Could not find frontend type ${typeName}`);
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
}

describe('AI workspace contract coverage', () => {
  it('has a renderer for every message part type', () => {
    const backendTypes = readBackendLiteralValues('AIMessagePartType');
    expect([...AI_MESSAGE_PART_TYPES].sort()).toEqual(backendTypes);
    expect(Object.keys(AI_MESSAGE_PART_RENDERERS).sort()).toEqual(backendTypes);
  });

  it('has a renderer for every result card type', () => {
    const backendTypes = readBackendLiteralValues('AIResultCardType');
    expect([...AI_RESULT_CARD_TYPES].sort()).toEqual(backendTypes);
    expect(Object.keys(AI_RESULT_CARD_RENDERERS).sort()).toEqual(backendTypes);
    expect(AI_RESULT_CARD_TYPES).toEqual(expect.arrayContaining([
      'recipe_shortage',
      'meal_idea_proposal',
    ]));
    expect(AI_RESULT_CARD_TYPES.includes('inventory_intake_candidates' as never)).toBe(false);
  });

  it('keeps frontend and backend draft types aligned', () => {
    const backendTypes = readBackendLiteralValues('AITaskDraftType');
    const frontendTypes = readFrontendDraftTypeValues();
    expect(frontendTypes).toEqual(backendTypes);
  });

  it('includes cancelling and cancelled run and event statuses', () => {
    expect(readFrontendLiteralValues('AiRunStatus')).toEqual(expect.arrayContaining([
      'cancelling',
      'cancelled',
    ]));
    expect(readFrontendLiteralValues('AiRunEventStatus')).toContain('cancelled');
  });
});
