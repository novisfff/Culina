import { describe, expect, it } from 'vitest';
import { abortAiStream, isExpectedAiStreamAbort } from './aiStreamAbort';

describe('AI stream abort contract', () => {
  it('recognizes only typed intentional aborts', () => {
    const controller = new AbortController();
    abortAiStream(controller, { type: 'cancel_accepted', runId: 'run-1' });

    expect(isExpectedAiStreamAbort(new DOMException('Aborted', 'AbortError'), controller.signal)).toBe(true);
    expect(isExpectedAiStreamAbort(
      new DOMException('Aborted', 'AbortError'),
      new AbortController().signal,
    )).toBe(false);
    expect(isExpectedAiStreamAbort(
      new Error('BodyStreamBuffer was aborted'),
      new AbortController().signal,
    )).toBe(false);
  });
});
