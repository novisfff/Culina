import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDomAndMocks, renderWithQuery, waitForAsync } from '../../test/renderWithQuery';
import { AiMobilePage } from './AiMobilePage';

function mockVisualViewport({ height, offsetTop }: { height: number; offsetTop: number }) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const viewport = new EventTarget() as VisualViewport;
  Object.defineProperties(viewport, {
    height: { value: height, writable: true, configurable: true },
    offsetTop: { value: offsetTop, writable: true, configurable: true },
    width: { value: 390, writable: true, configurable: true },
    offsetLeft: { value: 0, writable: true, configurable: true },
    pageLeft: { value: 0, writable: true, configurable: true },
    pageTop: { value: 0, writable: true, configurable: true },
    scale: { value: 1, writable: true, configurable: true },
  });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });

  return {
    viewport,
    restore() {
      if (originalDescriptor) {
        Object.defineProperty(window, 'visualViewport', originalDescriptor);
      } else {
        delete (window as unknown as Record<string, unknown>).visualViewport;
      }
    },
  };
}

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('AiMobilePage viewport', () => {
  it('anchors the AI page to the Safari visual viewport while tracking the keyboard inset', async () => {
    const visualViewport = mockVisualViewport({ height: 520, offsetTop: 0 });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    let rendered: Awaited<ReturnType<typeof renderWithQuery>> | null = null;
    try {
      rendered = await renderWithQuery(
        <AiMobilePage
          conversations={[]}
          isLoading={false}
          activeConversationKey={null}
          runningConversationKeys={new Set()}
          waitingConversationKeys={new Set()}
          isMobileHistoryOpen={false}
          currentUser={null}
          resourceOptionLoader={async () => []}
          messages={[]}
          runEventsById={{}}
          streamProgress={[]}
          thinkingRunIds={new Set()}
          activeAssistantRunId={null}
          activeStreamRunId={null}
          submittingApprovalId={null}
          draft=""
          attachments={[]}
          canAddAttachment
          hasUploadingAttachment={false}
          hasFailedAttachment={false}
          isSending={false}
          isComposerPaused={false}
          messagesLoading={false}
          onRetryMessages={() => undefined}
          onOpenMobileHistory={() => undefined}
          onCloseMobileHistory={() => undefined}
          onStartNewConversation={() => undefined}
          onSelectConversation={() => undefined}
          onDraftChange={() => undefined}
          onAttachmentFiles={() => undefined}
          onRemoveAttachment={() => undefined}
          onPasteFiles={() => undefined}
          onDropFiles={() => undefined}
          onPickSuggestion={() => undefined}
          onSubmit={(event) => event.preventDefault()}
          onApprovalDecision={() => undefined}
          onAddRecommendationToPlan={() => undefined}
          onInventoryAction={() => undefined}
          isInventoryActionPending={false}
          onCancelSending={() => undefined}
        />,
      );

      await waitForAsync(30);
      rendered.container.querySelector<HTMLTextAreaElement>('.ai-composer textarea')?.focus();
      visualViewport.viewport.dispatchEvent(new Event('resize'));
      await waitForAsync(300);

      const page = rendered.container.querySelector<HTMLElement>('.ai-mobile-page');
      expect(page?.style.getPropertyValue('--ai-mobile-viewport-height')).toBe('520px');
      expect(page?.style.getPropertyValue('--ai-mobile-viewport-top')).toBe('0px');
      expect(page?.style.getPropertyValue('--ai-mobile-keyboard-inset')).toBe('380px');
      expect(page?.style.getPropertyValue('--ai-mobile-composer-height')).toBe('88px');
      expect(page?.style.getPropertyValue('--ai-mobile-composer-safe-bottom')).toBe('0px');
      expect(page?.classList.contains('ai-mobile-keyboard-open')).toBe(true);

      visualViewport.viewport.dispatchEvent(new Event('resize'));
      rendered.container.querySelector<HTMLTextAreaElement>('.ai-composer textarea')?.blur();
      Object.defineProperties(window.visualViewport as VisualViewport, {
        height: { value: 900, writable: true, configurable: true },
        offsetTop: { value: 0, writable: true, configurable: true },
      });
      visualViewport.viewport.dispatchEvent(new Event('resize'));
      await waitForAsync(300);

      expect(page?.style.getPropertyValue('--ai-mobile-keyboard-inset')).toBe('0px');
      expect(page?.style.getPropertyValue('--ai-mobile-composer-safe-bottom')).toBe('env(safe-area-inset-bottom, 0px)');
      expect(page?.classList.contains('ai-mobile-keyboard-open')).toBe(false);
    } finally {
      rendered?.unmount();
      visualViewport.restore();
    }
  });
});
