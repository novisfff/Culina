import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  invalidateAfterFamilyChanged,
  invalidateAfterMemberChanged,
  invalidateAfterProfileChanged,
} from '../../api/cacheInvalidation';
import type { FamilyDetail, Member, UserSummary } from '../../api/types';
import { getMediaIds, getPendingImageJobId, type AiRenderPayload } from '../../lib/aiImages';
import { emptyImages } from '../../lib/ui';
import { useImageComposer } from '../../hooks/useImageComposer';
import type { NoticeState } from '../../hooks/useNotice';
import type {
  FamilyFormState,
  InviteFormState,
  MemberEditFormState,
  PasswordFormState,
  ProfileFormState,
} from './FamilySettingsModals';
import type { FamilyOverlayMode } from './FamilySettings';

function createInviteForm(): InviteFormState {
  return {
    username: '',
    displayName: '',
    password: '',
    role: 'Member',
    email: '',
  };
}

function createProfileForm(user?: UserSummary | null): ProfileFormState {
  return {
    displayName: user?.display_name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    avatarPrompt: '',
    avatarImages: user?.avatar_image ? { generatedAsset: user.avatar_image } : emptyImages(),
  };
}

function createMemberEditForm(member?: Member | null): MemberEditFormState {
  return {
    memberId: member?.id ?? '',
    displayName: member?.display_name ?? '',
    email: member?.email ?? '',
    phone: member?.phone ?? '',
  };
}

function createPasswordForm(): PasswordFormState {
  return {
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  };
}

function createFamilyForm(family?: FamilyDetail | null): FamilyFormState {
  return {
    name: family?.name ?? '',
    motto: family?.motto ?? '',
    location: family?.location ?? '',
    imagePrompt: '',
    images: family?.image ? { generatedAsset: family.image } : emptyImages(),
  };
}

function buildProfileImagePayload(form: ProfileFormState, role: string): AiRenderPayload {
  return {
    entity_type: 'user',
    title: form.displayName.trim() || '家庭成员',
    category: role,
    notes: [
      form.avatarPrompt.trim() ? `用户希望头像呈现：${form.avatarPrompt.trim()}` : '',
      form.email.trim() ? `邮箱：${form.email.trim()}` : '',
      form.phone.trim() ? `手机号：${form.phone.trim()}` : '',
    ].filter(Boolean).join('；'),
  };
}

function buildFamilyImagePayload(form: FamilyFormState): AiRenderPayload {
  return {
    entity_type: 'family',
    title: form.name.trim() || '家庭厨房',
    category: form.location.trim(),
    notes: [
      form.imagePrompt.trim() ? `Owner 希望家庭图呈现：${form.imagePrompt.trim()}` : '',
      form.motto.trim() ? `家庭口号：${form.motto.trim()}` : '',
    ].filter(Boolean).join('；'),
  };
}

export function useFamilySettingsState(input: {
  user?: UserSummary | null;
  family?: FamilyDetail | null;
  membershipRole?: string;
  isOwner: boolean;
  showNotice: (notice: NoticeState) => void;
}) {
  const queryClient = useQueryClient();
  const [overlayMode, setOverlayMode] = useState<FamilyOverlayMode>(null);
  const [inviteForm, setInviteForm] = useState<InviteFormState>(createInviteForm);
  const [profileForm, setProfileForm] = useState<ProfileFormState>(() => createProfileForm(input.user));
  const [memberEditForm, setMemberEditForm] = useState<MemberEditFormState>(() => createMemberEditForm());
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>(createPasswordForm);
  const [familyForm, setFamilyForm] = useState<FamilyFormState>(() => createFamilyForm(input.family));
  const [isProfileAvatarPromptOpen, setIsProfileAvatarPromptOpen] = useState(false);
  const [isFamilyImagePromptOpen, setIsFamilyImagePromptOpen] = useState(false);
  const profileImagePayload = buildProfileImagePayload(profileForm, input.membershipRole ?? 'Member');
  const familyImagePayload = buildFamilyImagePayload(familyForm);

  const profileImageComposer = useImageComposer({
    value: profileForm.avatarImages,
    payload: profileImagePayload,
    onChange: (next) => setProfileForm((current) => ({ ...current, avatarImages: next })),
  });
  const familyImageComposer = useImageComposer({
    value: familyForm.images,
    payload: familyImagePayload,
    onChange: (next) => setFamilyForm((current) => ({ ...current, images: next })),
  });

  const createMemberMutation = useMutation({
    mutationFn: api.createMember,
    onSuccess: () => {
      invalidateAfterMemberChanged(queryClient);
    },
  });
  const updateProfileMutation = useMutation({
    mutationFn: api.updateMe,
    onSuccess: () => {
      invalidateAfterProfileChanged(queryClient);
    },
  });
  const updateMemberMutation = useMutation({
    mutationFn: ({ memberId, payload }: { memberId: string; payload: Parameters<typeof api.updateMember>[1] }) =>
      api.updateMember(memberId, payload),
    onSuccess: () => {
      invalidateAfterProfileChanged(queryClient);
    },
  });
  const updatePasswordMutation = useMutation({
    mutationFn: api.updatePassword,
  });
  const updateFamilyMutation = useMutation({
    mutationFn: api.updateFamily,
    onSuccess: () => {
      invalidateAfterFamilyChanged(queryClient);
    },
  });

  useEffect(() => {
    if (!input.user) return;
    setProfileForm(createProfileForm(input.user));
  }, [
    input.user?.id,
    input.user?.display_name,
    input.user?.email,
    input.user?.phone,
    input.user?.avatar_seed,
    input.user?.avatar_image?.id,
  ]);

  useEffect(() => {
    if (!input.family) return;
    setFamilyForm(createFamilyForm(input.family));
  }, [
    input.family?.id,
    input.family?.name,
    input.family?.motto,
    input.family?.location,
    input.family?.image?.id,
  ]);

  function resetInviteForm() {
    setInviteForm(createInviteForm());
  }

  function resetPasswordForm() {
    setPasswordForm(createPasswordForm());
  }

  function openMemberEdit(member: Member) {
    setMemberEditForm(createMemberEditForm(member));
    setOverlayMode('member');
  }

  function closeOverlay() {
    setOverlayMode(null);
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteForm.username.trim() || !inviteForm.displayName.trim() || !inviteForm.password.trim()) return;
    try {
      await createMemberMutation.mutateAsync({
        username: inviteForm.username.trim(),
        display_name: inviteForm.displayName.trim(),
        password: inviteForm.password,
        role: inviteForm.role,
        email: inviteForm.email.trim() || undefined,
      });
      resetInviteForm();
      closeOverlay();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '创建成员账号失败', message: reason instanceof Error ? reason.message : '创建成员账号失败' });
    }
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileForm.displayName.trim()) return;
    try {
      await updateProfileMutation.mutateAsync({
        display_name: profileForm.displayName.trim(),
        email: profileForm.email.trim() || null,
        phone: profileForm.phone.trim() || null,
        avatar_seed: profileForm.displayName.trim(),
        avatar_media_id: getMediaIds(profileForm.avatarImages)[0] ?? null,
        pending_image_job_id: getPendingImageJobId(profileForm.avatarImages),
      });
      closeOverlay();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '保存个人资料失败', message: reason instanceof Error ? reason.message : '保存个人资料失败' });
    }
  }

  async function submitMemberEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.isOwner || !memberEditForm.memberId || !memberEditForm.displayName.trim()) return;
    try {
      await updateMemberMutation.mutateAsync({
        memberId: memberEditForm.memberId,
        payload: {
          display_name: memberEditForm.displayName.trim(),
          email: memberEditForm.email.trim() || null,
          phone: memberEditForm.phone.trim() || null,
        },
      });
      closeOverlay();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '保存成员信息失败', message: reason instanceof Error ? reason.message : '保存成员信息失败' });
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordForm.currentPassword || !passwordForm.newPassword) return;
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      input.showNotice({ tone: 'warning', title: '还不能修改密码', message: '两次输入的新密码不一致。' });
      return;
    }
    try {
      await updatePasswordMutation.mutateAsync({
        current_password: passwordForm.currentPassword,
        new_password: passwordForm.newPassword,
      });
      resetPasswordForm();
      closeOverlay();
      input.showNotice({ tone: 'success', title: '密码已更新', message: '下次登录请使用新密码。' });
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '修改密码失败', message: reason instanceof Error ? reason.message : '修改密码失败' });
    }
  }

  async function submitFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!familyForm.name.trim()) return;
    try {
      await updateFamilyMutation.mutateAsync({
        name: familyForm.name.trim(),
        motto: familyForm.motto.trim(),
        location: familyForm.location.trim(),
        image_media_id: getMediaIds(familyForm.images)[0] ?? null,
        pending_image_job_id: getPendingImageJobId(familyForm.images),
      });
      closeOverlay();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '保存家庭信息失败', message: reason instanceof Error ? reason.message : '保存家庭信息失败' });
    }
  }

  return {
    overlayMode,
    setOverlayMode,
    inviteForm,
    setInviteForm,
    profileForm,
    setProfileForm,
    memberEditForm,
    setMemberEditForm,
    passwordForm,
    setPasswordForm,
    familyForm,
    setFamilyForm,
    isProfileAvatarPromptOpen,
    setIsProfileAvatarPromptOpen,
    isFamilyImagePromptOpen,
    setIsFamilyImagePromptOpen,
    resetInviteForm,
    resetPasswordForm,
    openMemberEdit,
    closeOverlay,
    submitInvite,
    submitProfile,
    submitMemberEdit,
    submitPassword,
    submitFamily,
    isCreatingMember: createMemberMutation.isPending,
    isUpdatingProfile: updateProfileMutation.isPending,
    isUpdatingMember: updateMemberMutation.isPending,
    isUpdatingPassword: updatePasswordMutation.isPending,
    isUpdatingFamily: updateFamilyMutation.isPending,
    profileImageControls: {
      isGenerating: profileImageComposer.state.isGenerating,
      errorMessage: profileImageComposer.state.errorMessage,
      isPromptOpen: isProfileAvatarPromptOpen,
      onPromptOpen: () => setIsProfileAvatarPromptOpen(true),
      onPromptClose: () => setIsProfileAvatarPromptOpen(false),
      onUploadDirect: (files: FileList | null, alt: string) => void profileImageComposer.uploadDirect(files, alt),
      onGenerateText: () => profileImageComposer.generate('text'),
      onReset: profileImageComposer.reset,
    },
    familyImageControls: {
      isGenerating: familyImageComposer.state.isGenerating,
      errorMessage: familyImageComposer.state.errorMessage,
      isPromptOpen: isFamilyImagePromptOpen,
      onPromptOpen: () => setIsFamilyImagePromptOpen(true),
      onPromptClose: () => setIsFamilyImagePromptOpen(false),
      onUploadDirect: (files: FileList | null, alt: string) => void familyImageComposer.uploadDirect(files, alt),
      onGenerateText: () => familyImageComposer.generate('text'),
      onReset: familyImageComposer.reset,
    },
  };
}
