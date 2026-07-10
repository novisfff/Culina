import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery } from '../../test/renderWithQuery';
import { AiWorkspace } from './AiWorkspace';
import { conversation, qualityMetrics } from './aiWorkspaceTestFixtures';

afterEach(() => {
  cleanupTestDomAndMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'getAiStatus').mockResolvedValue({
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
  });
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
});

describe('AiWorkspace quality diagnostics', () => {
  it('opens recent run quality metrics from the AI status pill', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const qualitySpy = vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent).not.toContain('质量诊断');
    expect(qualitySpy).not.toHaveBeenCalled();

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-quality-trigger')?.click();
    });
    await flushAsync();

    expect(rendered.container.textContent).toContain('质量诊断');
    expect(rendered.container.textContent).toContain('最近 3 次运行');
    expect(rendered.container.textContent).toContain('运行成功率');
    expect(rendered.container.textContent).toContain('67%');
    expect(rendered.container.textContent).toContain('草稿一次通过');
    expect(rendered.container.textContent).toContain('80%（4/5）');
    expect(rendered.container.textContent).toContain('跨步骤完成');
    expect(rendered.container.textContent).toContain('确认时未修改');
    expect(rendered.container.textContent).toContain('运行信号');
        expect(rendered.container.textContent).toContain('Token 用量');
    expect(rendered.container.textContent).toContain('24 小时');
    expect(rendered.container.textContent).toContain('7 天');
    expect(rendered.container.textContent).toContain('30 天');
    expect(rendered.container.textContent).toContain('总 Token');
    expect(rendered.container.textContent).toContain('15.2K');
    expect(rendered.container.textContent).toContain('耗时表现');
        expect(rendered.container.textContent).toContain('安全护栏');
    expect(rendered.container.textContent).toContain('工具预算耗尽');
    expect(rendered.container.textContent).toContain('1 次');
    expect(rendered.container.textContent).toContain('常用 Skill');
    expect(rendered.container.textContent).toContain('餐食计划 · 2');
    expect(rendered.container.textContent).toContain('待关注');
    expect(rendered.container.textContent).toContain('provider stream failed · 1');
    expect(rendered.container.textContent).toContain('Provider');
    expect(rendered.container.textContent).toContain('Tool');
    expect(rendered.container.textContent).toContain('Script');
    expect(rendered.container.querySelectorAll('.ai-quality-stat')).toHaveLength(4);
    expect(rendered.container.querySelectorAll('.ai-quality-signal')).toHaveLength(4);
    expect(rendered.container.querySelectorAll('.ai-quality-mini')).toHaveLength(9);
    expect(rendered.container.querySelector('.ai-quality-health.is-attention')?.textContent).toBe('有运行提醒');
    expect(qualitySpy).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});
