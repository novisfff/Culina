// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ImageInputValue, MediaAsset } from '../api/types';
import { useImageComposer, type ImageGenerationUiState } from './useImageComposer';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function generatedAsset(id: string): MediaAsset {
  return {
    id,
    name: `${id}.png`,
    url: `/media/${id}.png`,
    source: 'ai',
    alt: 'AI 头像',
    generation_mode: 'text',
    created_at: '2026-07-04T00:00:00Z',
  };
}

function ComposerHarness(props: {
  value: ImageInputValue;
  onChange: (next: ImageInputValue) => void;
  onState: (state: ImageGenerationUiState) => void;
}) {
  const composer = useImageComposer({
    value: props.value,
    payload: { entity_type: 'user', title: '小李' },
    onChange: props.onChange,
  });
  props.onState(composer.state);

  return (
    <button
      type="button"
      onClick={() => composer.setState({ isGenerating: true, errorMessage: null, jobId: 'image-job-1' })}
    >
      mark generating
    </button>
  );
}

function renderHarness(props: Parameters<typeof ComposerHarness>[0]) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(<ComposerHarness {...props} />);
  });
  return container;
}

beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe('useImageComposer', () => {
  it('clears generating state when a pending job is replaced by a generated asset', () => {
    const states: ImageGenerationUiState[] = [];
    const onState = (next: ImageGenerationUiState) => {
      states.push(next);
    };
    const onChange = () => undefined;

    const view = renderHarness({
      value: { pendingJob: { job_id: 'image-job-1', status: 'running', generation_mode: 'text' } },
      onChange,
      onState,
    });

    act(() => {
      view.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(states.at(-1)?.isGenerating).toBe(true);

    renderHarness({
      value: { generatedAsset: generatedAsset('photo-avatar') },
      onChange,
      onState,
    });

    expect(states.at(-1)?.isGenerating).toBe(false);
    expect(states.at(-1)?.jobId).toBeNull();
  });
});
