// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { FamilyDetail } from '../../api/types';
import { emptyImages } from '../../lib/ui';
import { FamilySettings, type FamilyOverlayMode, type FamilySettingsProps } from './FamilySettings';
import type { FamilyActivityQueryState } from './FamilyActivityViewerModel';
import { tokenizeFamilyFoodContext } from './useFamilySettingsState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const family: FamilyDetail = {
  id: 'family-1',
  name: '温暖一家',
  motto: '认真吃饭',
  location: '上海',
  food_preferences: [],
  food_avoidances: [],
  created_at: '2026-07-10T00:00:00Z',
  updated_at: '2026-07-10T00:00:00Z',
  ai_recommendations: [],
};

function emptyActivityQuery(overrides: Partial<FamilyActivityQueryState> = {}): FamilyActivityQueryState {
  return {
    data: [],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function buildProps(overrides: Partial<FamilySettingsProps> = {}): FamilySettingsProps {
  return {
    family,
    members: [],
    currentUser: null,
    membership: null,
    isOwner: true,
    familyStatCards: [],
    currentUserRecentLogs: 0,
    activityQuery: emptyActivityQuery(),
    isPhoneViewport: false,
    overlayMode: 'family',
    familyForm: {
      name: family.name,
      motto: family.motto,
      location: family.location,
      foodPreferences: '',
      foodAvoidances: '',
      imagePrompt: '',
      images: emptyImages(),
    },
    inviteForm: { username: '', displayName: '', password: '', role: 'Member', email: '' },
    profileForm: { displayName: '', email: '', phone: '', avatarPrompt: '', avatarImages: emptyImages() },
    memberEditForm: { memberId: '', displayName: '', email: '', phone: '' },
    passwordForm: { currentPassword: '', newPassword: '', confirmPassword: '' },
    isCreatingMember: false,
    isUpdatingProfile: false,
    isUpdatingMember: false,
    isUpdatingPassword: false,
    isUpdatingFamily: false,
    profileImageControls: {
      isGenerating: false,
      isPromptOpen: false,
      onPromptOpen: vi.fn(),
      onPromptClose: vi.fn(),
      onUploadDirect: vi.fn(),
      onGenerateText: vi.fn(),
      onReset: vi.fn(),
    },
    familyImageControls: {
      isGenerating: false,
      isPromptOpen: false,
      onPromptOpen: vi.fn(),
      onPromptClose: vi.fn(),
      onUploadDirect: vi.fn(),
      onGenerateText: vi.fn(),
      onReset: vi.fn(),
    },
    resolveAssetUrl: (url) => url,
    onOverlayChange: vi.fn(),
    onNavigate: vi.fn(),
    onMemberEdit: vi.fn(),
    onInviteFormChange: vi.fn(),
    onProfileFormChange: vi.fn(),
    onMemberEditFormChange: vi.fn(),
    onPasswordFormChange: vi.fn(),
    onFamilyFormChange: vi.fn(),
    onInviteSubmit: vi.fn((event) => event.preventDefault()),
    onProfileSubmit: vi.fn((event) => event.preventDefault()),
    onMemberEditSubmit: vi.fn((event) => event.preventDefault()),
    onPasswordSubmit: vi.fn((event) => event.preventDefault()),
    onFamilySubmit: vi.fn((event) => event.preventDefault()),
    ...overrides,
  };
}

function renderSettings(props: Partial<FamilySettingsProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <FamilySettings {...buildProps(props)} />
      </QueryClientProvider>
    );
  });
  return container;
}

function rerenderSettings(props: Partial<FamilySettingsProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <FamilySettings {...buildProps(props)} />
      </QueryClientProvider>
    );
  });
}

function buttonByText(view: ParentNode, label: string) {
  const button = Array.from(view.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

describe('FamilySettings food context', () => {
  it('tokenizes comma and newline separated values with stable deduplication', () => {
    expect(tokenizeFamilyFoodContext('少油， 清淡\n少油、少盐')).toEqual(['少油', '清淡', '少盐']);
    expect(tokenizeFamilyFoodContext('  \n，')).toEqual([]);
  });

  it('shows the existing loading and empty states', () => {
    const view = renderSettings({ family: null, isLoading: true, overlayMode: null });
    expect(view.textContent).toContain('正在加载家庭资料');

    rerenderSettings({ family: null, isLoading: false, overlayMode: null });
    expect(view.textContent).toContain('暂时没有家庭资料');
  });

  it('keeps family food context owner-only and exposes a 403 error state', () => {
    const view = renderSettings({ isOwner: false, overlayMode: 'family' });
    expect(view.querySelector('.family-edit-modal')).toBeNull();

    rerenderSettings({ overlayMode: null, errorMessage: '403：只有主理人可以编辑家庭饮食偏好。' });
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('只有主理人');
  });

  it('renders tokenized preference fields with accessible validation and loading state', () => {
    const view = renderSettings({
      familyFormError: '每类最多填写 20 项',
      isUpdatingFamily: true,
    });

    const preferences = view.querySelector<HTMLTextAreaElement>('textarea[name="foodPreferences"]');
    const avoidances = view.querySelector<HTMLTextAreaElement>('textarea[name="foodAvoidances"]');
    expect(preferences?.labels?.[0]?.textContent).toContain('饮食偏好');
    expect(avoidances?.labels?.[0]?.textContent).toContain('忌口与规避');
    expect(preferences?.getAttribute('aria-invalid')).toBe('true');
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('每类最多填写 20 项');
    expect(Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('处理中'))?.disabled).toBe(true);
  });
});

describe('FamilySettings activity overlay control', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
  });

  it('opens activity overlay through controlled overlayMode on desktop', () => {
    const onOverlayChange = vi.fn();
    const view = renderSettings({
      overlayMode: null,
      isPhoneViewport: false,
      onOverlayChange,
    });

    act(() => buttonByText(view, '查看全部').click());
    expect(onOverlayChange).toHaveBeenCalledWith('activity');
    expect(view.querySelector('.family-activity-viewer-modal')).toBeNull();

    rerenderSettings({
      overlayMode: 'activity',
      isPhoneViewport: false,
      onOverlayChange,
    });
    expect(view.querySelectorAll('.family-activity-viewer-modal')).toHaveLength(1);
    expect(view.querySelector('.family-activity-mobile-page')).toBeNull();
  });

  it('renders one mobile activity page for the same overlay state', () => {
    const onOverlayChange = vi.fn();
    const view = renderSettings({
      overlayMode: 'activity',
      isPhoneViewport: true,
      onOverlayChange,
    });

    expect(view.querySelectorAll('.family-activity-mobile-page')).toHaveLength(1);
    expect(view.querySelector('.family-activity-viewer-modal')).toBeNull();
  });

  it('preserves overlayMode=activity when viewport switches desktop to phone', () => {
    const onOverlayChange = vi.fn();
    const view = renderSettings({
      overlayMode: 'activity' as FamilyOverlayMode,
      isPhoneViewport: false,
      onOverlayChange,
    });
    expect(view.querySelector('.family-activity-viewer-modal')).not.toBeNull();

    rerenderSettings({
      overlayMode: 'activity',
      isPhoneViewport: true,
      onOverlayChange,
    });

    expect(onOverlayChange).not.toHaveBeenCalled();
    expect(view.querySelector('.family-activity-mobile-page')).not.toBeNull();
    expect(view.querySelector('.family-activity-viewer-modal')).toBeNull();
  });

  it('closes activity presentation by clearing overlay only', () => {
    const onOverlayChange = vi.fn();
    const view = renderSettings({
      overlayMode: 'activity',
      isPhoneViewport: false,
      onOverlayChange,
    });

    act(() => {
      const close = view.querySelector<HTMLButtonElement>('button[aria-label="关闭家庭活动"]');
      close?.click();
    });
    expect(onOverlayChange).toHaveBeenCalledWith(null);

    rerenderSettings({
      overlayMode: 'activity',
      isPhoneViewport: true,
      onOverlayChange,
    });
    act(() => {
      const back = view.querySelector<HTMLButtonElement>('button[aria-label="返回家庭页"]');
      back?.click();
    });
    expect(onOverlayChange).toHaveBeenLastCalledWith(null);
  });
});
