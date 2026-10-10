import { createContext, useContext, useState, type Dispatch, type PropsWithChildren, type SetStateAction } from 'react';
import type { FamilyModelBindingDraft, FamilyModelProviderProfile } from '../../api/types/modelUsage';

export type CapabilityTestState = {
  fingerprint: string;
  requestId: number;
  status: 'running' | 'succeeded' | 'blocked' | 'failed' | 'request-error';
  message: string;
  checkedAt?: string;
  audioPreview?: string;
};

type TestStates = Record<string, CapabilityTestState>;
const TestContext = createContext<[TestStates, Dispatch<SetStateAction<TestStates>>] | null>(null);

/** Scoped to one family workspace, including section and viewport changes. */
export function CapabilityTestProvider({ children }: PropsWithChildren) {
  const state = useState<TestStates>({});
  return <TestContext.Provider value={state}>{children}</TestContext.Provider>;
}

export function useCapabilityTestState() {
  const shared = useContext(TestContext);
  const local = useState<TestStates>({});
  return shared ?? local;
}

export function capabilityTestFingerprint(binding: FamilyModelBindingDraft, profile?: FamilyModelProviderProfile) {
  return JSON.stringify([binding, profile?.profile_version_number, profile?.version_number, profile?.credential.version_number]);
}
