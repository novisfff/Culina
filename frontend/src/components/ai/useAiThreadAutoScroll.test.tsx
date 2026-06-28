import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDomAndMocks, renderWithQuery } from '../../test/renderWithQuery';
import { useAiThreadAutoScroll } from './useAiThreadAutoScroll';

function AutoScrollHarness({
  contentKey,
  activeOutputKey,
  resetKey = 'conversation-1',
}: {
  contentKey: string;
  activeOutputKey: string | null;
  resetKey?: string | null;
}) {
  const autoScroll = useAiThreadAutoScroll({
    contentKey,
    resetKey,
    activeOutputKey,
    forceScrollKey: null,
  });
  return (
    <div>
      <div className="ai-thread-scroll" ref={autoScroll.threadScrollRef}>
        <p>{contentKey}</p>
      </div>
      {autoScroll.isAutoScrollPaused ? (
        <button type="button" className="ai-thread-follow-button" onClick={autoScroll.resumeAutoScroll}>
          最新回复
        </button>
      ) : null}
    </div>
  );
}

function setThreadScrollMetrics(node: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, value: metrics.scrollTop, writable: true },
  });
}

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('Ai thread auto scroll', () => {
  it('follows streaming output while pinned to the bottom', async () => {
    const rendered = await renderWithQuery(<AutoScrollHarness contentKey="step-1" activeOutputKey="run-1" />);
    const thread = rendered.container.querySelector<HTMLElement>('.ai-thread-scroll') as HTMLElement;
    setThreadScrollMetrics(thread, { scrollHeight: 900, clientHeight: 300, scrollTop: 600 });

    await rendered.rerender(<AutoScrollHarness contentKey="step-2" activeOutputKey="run-1" />);
    expect(thread.scrollTop).toBe(900);
    expect(rendered.container.querySelector('.ai-thread-follow-button')).toBeNull();
    rendered.unmount();
  });

  it('pauses follow mode when the user scrolls away and resumes from the button', async () => {
    const rendered = await renderWithQuery(<AutoScrollHarness contentKey="step-1" activeOutputKey="run-1" />);
    const thread = rendered.container.querySelector<HTMLElement>('.ai-thread-scroll') as HTMLElement;
    setThreadScrollMetrics(thread, { scrollHeight: 900, clientHeight: 300, scrollTop: 600 });
    await rendered.rerender(<AutoScrollHarness contentKey="step-2" activeOutputKey="run-1" />);

    thread.scrollTop = 320;
    await act(async () => {
      thread.dispatchEvent(new Event('scroll'));
    });
    setThreadScrollMetrics(thread, { scrollHeight: 1100, clientHeight: 300, scrollTop: 320 });
    await rendered.rerender(<AutoScrollHarness contentKey="step-3" activeOutputKey="run-1" />);

    expect(thread.scrollTop).toBe(320);
    const followButton = rendered.container.querySelector<HTMLButtonElement>('.ai-thread-follow-button');
    expect(followButton).not.toBeNull();
    await act(async () => {
      followButton?.click();
    });
    expect(thread.scrollTop).toBe(1100);
    rendered.unmount();
  });

  it('cancels queued follow frames as soon as the user scrolls upward', async () => {
    let nextFrameId = 1;
    const queuedFrames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      queuedFrames.delete(frameId);
    });

    const flushAnimationFrames = () => {
      const callbacks = Array.from(queuedFrames.values());
      queuedFrames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    };

    const rendered = await renderWithQuery(<AutoScrollHarness contentKey="step-1" activeOutputKey="run-1" />);
    const thread = rendered.container.querySelector<HTMLElement>('.ai-thread-scroll') as HTMLElement;
    setThreadScrollMetrics(thread, { scrollHeight: 900, clientHeight: 300, scrollTop: 600 });
    await rendered.rerender(<AutoScrollHarness contentKey="step-2" activeOutputKey="run-1" />);

    thread.scrollTop = 320;
    await act(async () => {
      thread.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 }));
    });
    setThreadScrollMetrics(thread, { scrollHeight: 1100, clientHeight: 300, scrollTop: 320 });
    flushAnimationFrames();

    expect(thread.scrollTop).toBe(320);
    expect(rendered.container.querySelector('.ai-thread-follow-button')).not.toBeNull();
    rendered.unmount();
  });
});
