import { readJsonStorage, writeJsonStorage } from '../lib/storage';
import type { LoginResponse } from './types';

const AUTH_COOKIE_LOCK_NAME = 'culina-auth-cookie-v1';
const AUTH_TRANSITION_SEQUENCE_KEY = 'culina-auth-transition-sequence-v1';
const AUTH_TRANSITION_CHANNEL_NAME = 'culina-auth-transition-v1';

type AuthTransitionMessage = {
  sourceId: string;
  sequence: number;
  payload: LoginResponse | null;
};

const sourceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const transitionListeners = new Set<(payload: LoginResponse | null) => void>();
let sameTabTail: Promise<unknown> = Promise.resolve();
let transitionChannel: BroadcastChannel | null | undefined;
let lastAppliedSequence = 0;

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
    return transitionChannel;
  }
  transitionChannel = new window.BroadcastChannel(AUTH_TRANSITION_CHANNEL_NAME);
  transitionChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isTransitionMessage(message)) return;
    if (message.sourceId === sourceId || message.sequence <= lastAppliedSequence) return;
    lastAppliedSequence = message.sequence;
    transitionListeners.forEach((listener) => listener(message.payload));
  });
  return transitionChannel;
}

async function withBrowserLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!lockManager?.request) return operation();
  return lockManager.request(
    AUTH_COOKIE_LOCK_NAME,
    { mode: 'exclusive' },
    () => operation(),
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
  const storedSequence = readJsonStorage<number>(AUTH_TRANSITION_SEQUENCE_KEY, 0);
  const sequence = Math.max(storedSequence, lastAppliedSequence) + 1;
  lastAppliedSequence = sequence;
  writeJsonStorage(AUTH_TRANSITION_SEQUENCE_KEY, sequence);
  getTransitionChannel()?.postMessage({ sourceId, sequence, payload } satisfies AuthTransitionMessage);
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
