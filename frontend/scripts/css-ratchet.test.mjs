import { describe, expect, it } from 'vitest';

import {
  compareCssDebt,
  normalizeMediaQuery,
  scanCssDebtContent,
  scanSpecificity,
} from './css-ratchet.mjs';


function emptyDebt() {
  return {
    important: [],
    businessSpecificity: [],
    attributeSelector: [],
    noncanonicalMedia: [],
    semanticMedia: [],
  };
}


describe('CSS debt ratchet', () => {
  it('calculates selector specificity and compound depth', () => {
    expect(scanSpecificity('#app .workspace > article.card [data-state="open"]::before')).toEqual({
      ids: 1,
      classes: 3,
      elements: 2,
      depth: 4,
    });
    expect(scanSpecificity(':where(.shell) .card:is(.active, #featured)')).toEqual({
      ids: 1,
      classes: 1,
      elements: 0,
      depth: 2,
    });
  });

  it('normalizes canonical, semantic, and noncanonical media queries', () => {
    expect(normalizeMediaQuery('@MEDIA ( max-width : 767.0px )')).toBe('canonical');
    expect(normalizeMediaQuery('@media (min-width: 768px) and (max-width: 1023px)')).toBe('canonical');
    expect(normalizeMediaQuery('@media (pointer: coarse)')).toBe('semantic');
    expect(normalizeMediaQuery('@media (prefers-reduced-motion: reduce)')).toBe('semantic');
    expect(normalizeMediaQuery('@media (forced-colors: active)')).toBe('semantic');
    expect(normalizeMediaQuery('@media print')).toBe('semantic');
    expect(normalizeMediaQuery('@media (max-width: 420px)')).toBe('noncanonical');
    expect(normalizeMediaQuery('@media (max-width: 520px)')).toBe('noncanonical');
  });

  it('ignores comments and strings but reports new important and deep business selectors', () => {
    const current = scanCssDebtContent(`
      /* .comment .only .selector { color: red !important; } */
      .fixture::before { content: "!important"; }
      .workspace .panel .title { color: red !important; }
    `, { file: 'src/styles/fixture.css', owner: 'fixture' });
    const result = compareCssDebt(current, emptyDebt(), []);

    expect(current.important).toHaveLength(1);
    expect(current.businessSpecificity).toEqual([
      expect.objectContaining({ selectorOrValue: '.workspace .panel .title', owner: 'fixture' }),
    ]);
    expect(result.violations.map(({ metric }) => metric)).toEqual([
      'business-specificity',
      'important',
    ]);
  });

  it('rejects noncanonical media but permits semantic media with an owner', () => {
    const current = scanCssDebtContent(`
      @media (max-width: 420px) { .fixture { display: block; } }
      @media (pointer: coarse) { .fixture { min-height: 44px; } }
      @media (prefers-reduced-motion: reduce) { .fixture { transition: none; } }
      @media (forced-colors: active) { .fixture { border: 1px solid; } }
      @media print { .fixture { display: block; } }
    `, { file: 'src/styles/fixture.css', owner: 'fixture' });
    const result = compareCssDebt(current, emptyDebt(), []);

    expect(current.noncanonicalMedia).toHaveLength(1);
    expect(current.semanticMedia).toHaveLength(4);
    expect(result.violations).toEqual([
      expect.objectContaining({ metric: 'noncanonical-media', selectorOrValue: '(max-width: 420px)' }),
    ]);
  });

  it('reports reductions and groups debt by owner', () => {
    const baseline = scanCssDebtContent(`
      .workspace .panel .title { color: red !important; }
      @media (max-width: 520px) { .fixture { display: block; } }
    `, { file: 'src/styles/fixture.css', owner: 'fixture' });
    const current = scanCssDebtContent('.fixture { color: red; }', {
      file: 'src/styles/fixture.css',
      owner: 'fixture',
    });
    const result = compareCssDebt(current, baseline, []);

    expect(result.violations).toEqual([]);
    expect(result.reductions.map(({ metric, delta }) => ({ metric, delta }))).toEqual([
      { metric: 'business-specificity', delta: -1 },
      { metric: 'important', delta: -1 },
      { metric: 'media', delta: -1 },
      { metric: 'noncanonical-media', delta: -1 },
    ]);
    expect(result.byOwner.fixture).toEqual(expect.objectContaining({
      important: 0,
      businessSpecificity: 0,
      noncanonicalMedia: 0,
      semanticMedia: 0,
    }));
  });
});
