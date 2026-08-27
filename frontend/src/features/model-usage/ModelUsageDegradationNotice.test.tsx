// @vitest-environment jsdom

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelUsageDegradationNotice,
  modelUsageErrorCodeFromReason,
  onsiteModelUsageOption,
} from './ModelUsageDegradationNotice';
import { ApiError } from '../../api/request';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('ModelUsageDegradationNotice', () => {
  it('maps only stable model-usage error codes to capability-specific safe copy', () => {
    expect(onsiteModelUsageOption('model_usage_capability_limit_exceeded', 'rerank')).toMatchObject({
      tone: 'warning',
      message: '搜索排序额度达到限制，本次已改用基础排序。',
    });
    expect(onsiteModelUsageOption('provider_429', 'rerank')).toBeNull();
    expect(onsiteModelUsageOption(null, 'rerank')).toBeNull();
  });

  it('extracts a stable code from the structured API error payload instead of its text', () => {
    const reason = new ApiError({
      status: 429,
      detail: '当前语音额度受限，请改用文字输入。',
      path: '/api/ai/audio/transcriptions',
      payload: {
        detail: {
          code: 'model_usage_capability_limit_exceeded',
          message: '当前语音额度受限，请改用文字输入。',
        },
      },
    });

    expect(modelUsageErrorCodeFromReason(reason)).toBe('model_usage_capability_limit_exceeded');
    expect(modelUsageErrorCodeFromReason(new Error('model_usage_capability_limit_exceeded'))).toBeNull();
  });

  it('renders a semantic, amount-free realtime fallback notice', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ModelUsageDegradationNotice
          capability="realtime_audio"
          code="model_usage_capability_limit_exceeded"
        />,
      );
    });

    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('语音额度已达到限制，本次会话已结束；可以继续使用文字。');
    expect(notice?.textContent).not.toMatch(/¥|预算比例|家庭已用/);
  });
});
