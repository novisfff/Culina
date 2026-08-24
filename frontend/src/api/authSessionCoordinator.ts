import { readStringStorage, writeStringStorage } from '../lib/storage';
import type { LoginResponse } from './types';

const AUTH_COOKIE_LOCK_NAME = 'culina-auth-cookie-v1';
const AUTH_TRANSITION_SEQUENCE_KEY = 'culina-auth-transition-sequence-v1';
const AUTH_TRANSITION_CHANNEL_NAME = 'culina-auth-transition-v1';
const AUTH_TRANSITION_WAIT_TIMEOUT_MS = 5_000;

type AuthTransitionMessage = {
  sourceId: string;
  sequence: number;
  payload: LoginResponse | null;
};

type AuthTransitionWaiter = {
  targetSequence: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: () => void;
};

const sourceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const transitionListeners = new Set<(payload: LoginResponse | null) => void>();
const transitionWaiters = new Set<AuthTransitionWaiter>();
let sameTabTail: Promise<unknown> = Promise.resolve();
let transitionChannel: BroadcastChannel | null | undefined;
let lastAppliedSequence = 0;
let transitionBaselineInitialized = false;
let transitionStorageError: Error | null = null;

function unavailableTransitionStorage(): Error {
  transitionStorageError = new Error('认证状态存储不可用，请检查浏览器隐私设置后重试');
  return transitionStorageError;
}

function readStoredTransitionSequence(): number {
  try {
    const raw = readStringStorage(AUTH_TRANSITION_SEQUENCE_KEY, '0');
    const sequence: unknown = JSON.parse(raw);
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0) {
      throw new Error('invalid auth transition sequence');
    }
    transitionStorageError = null;
    return Number(sequence);
  } catch {
    throw unavailableTransitionStorage();
  }
}

function writeStoredTransitionSequence(sequence: number): void {
  const serialized = JSON.stringify(sequence);
  try {
    writeStringStorage(AUTH_TRANSITION_SEQUENCE_KEY, serialized);
    if (readStringStorage(AUTH_TRANSITION_SEQUENCE_KEY, '') !== serialized) {
      throw new Error('auth transition sequence write verification failed');
    }
    transitionStorageError = null;
  } catch {
    throw unavailableTransitionStorage();
  }
}

function initializeTransitionBaseline(): void {
  if (transitionBaselineInitialized) return;
  transitionBaselineInitialized = true;
  try {
    lastAppliedSequence = readStoredTransitionSequence();
  } catch {
    lastAppliedSequence = 0;
  }
}

function resolveTransitionWaiters(): void {
  transitionWaiters.forEach((waiter) => {
    if (waiter.targetSequence > lastAppliedSequence) return;
    transitionWaiters.delete(waiter);
    clearTimeout(waiter.timeoutId);
    waiter.resolve();
  });
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LoginResponse>;
  return Boolean(
    typeof candidate.access_token === 'string'
    && candidate.user
    && typeof candidate.user.id === 'string'
    && candidate.membership
    && typeof candidate.membership.family_id === 'string'
    && candidate.family
    && typeof candidate.family.id === 'string'
  );
}

function isTransitionMessage(value: unknown): value is AuthTransitionMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthTransitionMessage>;
  return Boolean(
    typeof candidate.sourceId === 'string'
    && Number.isSafeInteger(candidate.sequence)
    && Number(candidate.sequence) > 0
    && (candidate.payload === null || isLoginResponse(candidate.payload))
  );
}

function getTransitionChannel(): BroadcastChannel | null {
  if (transitionChannel !== undefined) return transitionChannel;
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') {
    transitionChannel = null;
    initializeTransitionBaseline();
    return transitionChannel;
  }
  transitionChannel = new window.BroadcastChannel(AUTH_TRANSITION_CHANNEL_NAME);
  transitionChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isTransitionMessage(message)) return;
    if (message.sourceId === sourceId || message.sequence <= lastAppliedSequence) return;
    lastAppliedSequence = message.sequence;
    transitionListeners.forEach((listener) => listener(message.payload));
    resolveTransitionWaiters();
  });
  initializeTransitionBaseline();
  return transitionChannel;
}

function waitForCommittedTransitions(): Promise<void> {
  const channel = getTransitionChannel();
  const targetSequence = readStoredTransitionSequence();
  writeStoredTransitionSequence(targetSequence);
  if (targetSequence <= lastAppliedSequence) return Promise.resolve();
  if (!channel) {
    return Promise.reject(new Error('浏览器无法同步认证状态，请刷新后重试'));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: AuthTransitionWaiter = {
      targetSequence,
      timeoutId: setTimeout(() => {
        transitionWaiters.delete(waiter);
        reject(new Error('认证状态同步超时，请刷新后重试'));
      }, AUTH_TRANSITION_WAIT_TIMEOUT_MS),
      resolve,
    };
    transitionWaiters.add(waiter);
    resolveTransitionWaiters();
  });
}

async function withBrowserLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!lockManager?.request) {
    await waitForCommittedTransitions();
    return operation();
  }
  return lockManager.request(
    AUTH_COOKIE_LOCK_NAME,
    { mode: 'exclusive' },
    async () => {
      await waitForCommittedTransitions();
      return operation();
    },
  );
}

export function withAuthCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = sameTabTail.then(() => withBrowserLock(operation));
  sameTabTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function publishAuthCookieTransition(payload: LoginResponse | null): void {
  const channel = getTransitionChannel();
  const storedSequence = readStoredTransitionSequence();
  const sequence = Math.max(storedSequence, lastAppliedSequence) + 1;
  writeStoredTransitionSequence(sequence);
  lastAppliedSequence = sequence;
  resolveTransitionWaiters();
  channel?.postMessage({ sourceId, sequence, payload } satisfies AuthTransitionMessage);
}

export function subscribeAuthCookieTransition(
  listener: (payload: LoginResponse | null) => void,
): () => void {
  transitionListeners.add(listener);
  getTransitionChannel();
  return () => {
    transitionListeners.delete(listener);
  };
}
