// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AiDraftImpactNote } from './AiDraftImpactNote';
import { AiDraftItemCard } from './AiDraftItemCard';
import { AiDraftResolvedSummary } from './AiDraftResolvedSummary';
import { AiDraftSection } from './AiDraftSection';
import { AiDraftSummaryCard } from './AiDraftSummaryCard';

describe('AI Draft structural primitives', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function renderPrimitive(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('renders a titled summary with its facts', () => {
    const view = renderPrimitive(
      <AiDraftSummaryCard title="本次变更" items={[{ label: '处理项', value: '3 项' }, { label: '日期', value: '今天' }]} />,
    );

    expect(view.querySelector('[role="region"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(view.querySelector('h3')?.textContent).toBe('本次变更');
    expect(view.textContent).toContain('处理项');
    expect(view.textContent).toContain('3 项');
  });

  it('connects a section title with its content and action', () => {
    const view = renderPrimitive(
      <AiDraftSection title="食材" action={<button type="button">新增食材</button>}>
        <p>西红柿</p>
      </AiDraftSection>,
    );

    const section = view.querySelector<HTMLElement>('[role="region"]');
    const heading = view.querySelector('h3');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(view.querySelector('button')?.textContent).toBe('新增食材');
    expect(view.textContent).toContain('西红柿');
  });

  it('uses note and alert semantics for Draft impact', () => {
    const view = renderPrimitive(
      <>
        <AiDraftImpactNote tone="warning" title="确认影响">库存会同步更新。</AiDraftImpactNote>
        <AiDraftImpactNote tone="danger" title="删除影响">删除后无法恢复。</AiDraftImpactNote>
      </>,
    );

    expect(view.querySelector('[role="note"]')?.textContent).toContain('确认影响');
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('删除后无法恢复');
  });

  it('keeps an item footer with its item content', () => {
    const view = renderPrimitive(
      <AiDraftItemCard title="番茄" summary="2 个" footer={<button type="button">移除</button>}>
        <p>成熟度良好</p>
      </AiDraftItemCard>,
    );

    expect(view.querySelector('h4')?.textContent).toBe('番茄');
    expect(view.textContent).toContain('成熟度良好');
    expect(view.querySelector('button')?.textContent).toBe('移除');
  });

  it('maps each resolved Draft status to readable text', () => {
    const statuses = [
      ['approved', '已确认'],
      ['rejected', '已拒绝'],
      ['expired', '已失效'],
      ['cancelled', '已取消'],
      ['canceled', '已取消'],
    ] as const;

    for (const [status, label] of statuses) {
      const view = renderPrimitive(<AiDraftResolvedSummary status={status} title="入库草稿" summary="已保留处理结果" />);
      expect(view.textContent).toContain(label);
      act(() => root?.unmount());
      container?.replaceChildren();
    }
  });
});
