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
    configured: true,
    enabled: true,
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
    capabilities: {
      llm: 'available',
      image_generation: 'available',
      stt: 'available',
      tts: 'available',
      realtime_audio: 'available',
      embedding: 'available',
      rerank: 'available',
    },
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

    expect(rendered.container.textContent).not.toContain('AI 使用情况');
    expect(qualitySpy).not.toHaveBeenCalled();

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-quality-trigger')?.click();
    });
    await flushAsync();

    expect(rendered.container.textContent).toContain('AI 使用情况');
    expect(rendered.container.textContent).toContain('最近 3 次处理');
    expect(rendered.container.textContent).toContain('处理成功率');
    expect(rendered.container.textContent).toContain('67%');
    expect(rendered.container.textContent).toContain('草稿一次通过');
    expect(rendered.container.textContent).toContain('80%（4/5）');
    expect(rendered.container.textContent).toContain('跨步骤完成');
    expect(rendered.container.textContent).toContain('确认时未修改');
    expect(rendered.container.textContent).toContain('处理情况');
    expect(rendered.container.textContent).toContain('文本用量');
    expect(rendered.container.textContent).toContain('24 小时');
    expect(rendered.container.textContent).toContain('7 天');
    expect(rendered.container.textContent).toContain('30 天');
    expect(rendered.container.textContent).toContain('总用量');
    expect(rendered.container.textContent).toContain('15.2K');
    expect(rendered.container.textContent).toContain('耗时表现');
    expect(rendered.container.textContent).toContain('安全限制');
    expect(rendered.container.textContent).toContain('工具处理超限');
    expect(rendered.container.textContent).toContain('1 次');
    expect(rendered.container.textContent).toContain('常用能力');
    expect(rendered.container.textContent).toContain('餐食计划 · 2');
    expect(rendered.container.textContent).toContain('待关注');
    expect(rendered.container.textContent).toContain('模型回复中断 · 1');
    expect(rendered.container.textContent).toContain('模型服务');
    expect(rendered.container.textContent).toContain('自动处理');
    expect(rendered.container.querySelectorAll('.ai-quality-stat')).toHaveLength(4);
    expect(rendered.container.querySelectorAll('.ai-quality-signal')).toHaveLength(4);
    expect(rendered.container.querySelectorAll('.ai-quality-mini')).toHaveLength(9);
    expect(rendered.container.querySelector('.ai-quality-health.is-attention')?.textContent).toBe('有待处理提醒');
    expect(qualitySpy).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});
