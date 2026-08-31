#!/usr/bin/env node

import { GATE_KEYS } from './classify-pr-gates.mjs';
import { pathToFileURL } from 'node:url';

function envKey(prefix, gate) {
  return `${prefix}_${gate.toUpperCase()}`;
}

export function verifyGateResults(env = process.env) {
  const errors = [];
  if (env.CLASSIFY_RESULT !== 'success') errors.push(`classify job finished with ${env.CLASSIFY_RESULT || 'unknown'}`);

  for (const gate of GATE_KEYS) {
    const required = env[envKey('REQUIRE', gate)] === 'true';
    const result = env[envKey('RESULT', gate)] || 'missing';
    if (required && result !== 'success') errors.push(`${gate} is required but finished with ${result}`);
    if (!required && !['success', 'skipped'].includes(result)) errors.push(`${gate} was not selected but finished with ${result}`);
  }

  if (errors.length) {
    const error = new Error(`PR Gate failed:\n- ${errors.join('\n- ')}`);
    error.errors = errors;
    throw error;
  }
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyGateResults();
    console.log('PR Gate passed: every selected gate succeeded.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
