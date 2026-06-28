import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function renderWithQuery(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });

  return {
    container,
    queryClient,
    rerender: async (nextElement: React.ReactElement) => {
      await act(async () => {
        root?.render(<QueryClientProvider client={queryClient}>{nextElement}</QueryClientProvider>);
      });
    },
    unmount: () => {
      act(() => {
        root?.unmount();
        container.remove();
      });
    },
  };
}

export async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

export async function waitForAsync(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
  });
}

export function cleanupTestDomAndMocks() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
}

export function changeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
