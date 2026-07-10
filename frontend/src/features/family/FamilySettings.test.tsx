// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FamilyDetail } from '../../api/types';
import { emptyImages } from '../../lib/ui';
import { FamilySettings, type FamilySettingsProps } from './FamilySettings';
import { tokenizeFamilyFoodContext } from './useFamilySettingsState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
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

function buildProps(overrides: Partial<FamilySettingsProps> = {}): FamilySettingsProps {
  return {
    family,
    members: [],
    currentUser: null,
    membership: null,
    isOwner: true,
    familyStatCards: [],
    currentUserRecentLogs: 0,
    activityLogs: [],
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
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<FamilySettings {...buildProps(props)} />));
  return container;
}

describe('FamilySettings food context', () => {
  it('tokenizes comma and newline separated values with stable deduplication', () => {
    expect(tokenizeFamilyFoodContext('少油， 清淡\n少油、少盐')).toEqual(['少油', '清淡', '少盐']);
    expect(tokenizeFamilyFoodContext('  \n，')).toEqual([]);
  });

  it('shows the existing loading and empty states', () => {
    const view = renderSettings({ family: null, isLoading: true, overlayMode: null });
    expect(view.textContent).toContain('正在加载家庭资料');

    act(() => root?.render(<FamilySettings {...buildProps({ family: null, isLoading: false, overlayMode: null })} />));
    expect(view.textContent).toContain('暂时没有家庭资料');
  });

  it('keeps family food context owner-only and exposes a 403 error state', () => {
    const view = renderSettings({ isOwner: false, overlayMode: 'family' });
    expect(view.querySelector('.family-edit-modal')).toBeNull();

    act(() => root?.render(<FamilySettings {...buildProps({ overlayMode: null, errorMessage: '403：只有主理人可以编辑家庭饮食偏好。' })} />));
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
