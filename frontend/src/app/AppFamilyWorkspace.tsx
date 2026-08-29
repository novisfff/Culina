import { lazy, Suspense, type ComponentProps } from 'react';
import type { AppNavigationState } from './appNavigationModel';
import { canRenderFamilyAiServices } from './appNavigationModel';
import type { FamilyDetail, Member, MembershipSummary, UserSummary } from '../api/types/shell';

const FamilySettings = lazy(() => import('./routeEntries/family').then((module) => module.loadFamilySettings()));
const ModelUsageWorkspace = lazy(() => import('./routeEntries/modelUsage').then((module) => module.loadModelUsageWorkspace()));
const ModelUsageRequestLogsPage = lazy(() => import('./routeEntries/modelUsage').then((module) => module.loadModelUsageRequestLogs()));
const FamilyModelSettingsWorkspace = lazy(() => import('./routeEntries/modelUsage').then((module) => module.loadFamilyModelSettings()));

type FamilySettingsProps = ComponentProps<typeof FamilySettings>;

export type AppFamilyWorkspaceProps = {
  state: AppNavigationState;
  isOwner: boolean;
  family: FamilyDetail | null;
  familyQueryError: unknown;
  members: Member[];
  currentUser: UserSummary | null;
  membership: MembershipSummary | null;
  familyHeroImageUrl?: string;
  familyStatCards: FamilySettingsProps['familyStatCards'];
  currentUserRecentLogs: FamilySettingsProps['currentUserRecentLogs'];
  familyOwnerMember: FamilySettingsProps['familyOwnerMember'];
  activityQuery: FamilySettingsProps['activityQuery'];
  activityPhase: FamilySettingsProps['activityPhase'];
  isPhoneViewport: boolean;
  notificationCenter: FamilySettingsProps['notificationCenter'];
  overlayMode: FamilySettingsProps['overlayMode'];
  editingMember: FamilySettingsProps['editingMember'];
  inviteForm: FamilySettingsProps['inviteForm'];
  profileForm: FamilySettingsProps['profileForm'];
  memberEditForm: FamilySettingsProps['memberEditForm'];
  passwordForm: FamilySettingsProps['passwordForm'];
  familyForm: FamilySettingsProps['familyForm'];
  isCreatingMember: FamilySettingsProps['isCreatingMember'];
  isUpdatingProfile: FamilySettingsProps['isUpdatingProfile'];
  isUpdatingMember: FamilySettingsProps['isUpdatingMember'];
  isUpdatingPassword: FamilySettingsProps['isUpdatingPassword'];
  isUpdatingFamily: FamilySettingsProps['isUpdatingFamily'];
  familyFormError: FamilySettingsProps['familyFormError'];
  profileImageControls: FamilySettingsProps['profileImageControls'];
  familyImageControls: FamilySettingsProps['familyImageControls'];
  resolveAssetUrl: FamilySettingsProps['resolveAssetUrl'];
  onOverlayChange: FamilySettingsProps['onOverlayChange'];
  onNavigate: FamilySettingsProps['onNavigate'];
  onMemberEdit: FamilySettingsProps['onMemberEdit'];
  onInviteFormChange: FamilySettingsProps['onInviteFormChange'];
  onProfileFormChange: FamilySettingsProps['onProfileFormChange'];
  onMemberEditFormChange: FamilySettingsProps['onMemberEditFormChange'];
  onPasswordFormChange: FamilySettingsProps['onPasswordFormChange'];
  onFamilyFormChange: FamilySettingsProps['onFamilyFormChange'];
  onInviteSubmit: FamilySettingsProps['onInviteSubmit'];
  onProfileSubmit: FamilySettingsProps['onProfileSubmit'];
  onMemberEditSubmit: FamilySettingsProps['onMemberEditSubmit'];
  onPasswordSubmit: FamilySettingsProps['onPasswordSubmit'];
  onFamilySubmit: FamilySettingsProps['onFamilySubmit'];
};

export function AppFamilyWorkspace(props: AppFamilyWorkspaceProps) {
  const familyView = props.state.family.view;
  if (canRenderFamilyAiServices(familyView, props.isOwner)) {
    return (
      <Suspense fallback={null}>
        <FamilyModelSettingsWorkspace
          familyId={props.family?.id ?? ''}
          role={props.membership?.role ?? 'Member'}
          isPhoneViewport={props.isPhoneViewport}
          onBack={() => props.onNavigate({ workspace: 'family', view: 'profile' })}
        />
      </Suspense>
    );
  }
  if (familyView === 'modelUsageRequests') {
    return (
      <Suspense fallback={null}>
        <ModelUsageRequestLogsPage
          familyId={props.family?.id ?? ''}
          role={props.membership?.role ?? 'Member'}
          initialPeriod={props.state.family.period}
          isPhoneViewport={props.isPhoneViewport}
          onBack={() => props.onNavigate({ workspace: 'family', view: 'modelUsage' })}
        />
      </Suspense>
    );
  }
  if (familyView === 'modelUsage') {
    return (
      <Suspense fallback={null}>
        <ModelUsageWorkspace
          familyId={props.family?.id ?? ''}
          role={props.membership?.role ?? 'Member'}
          initialPeriod={props.state.family.period}
          isPhoneViewport={props.isPhoneViewport}
          onBack={() => props.onNavigate({ workspace: 'family', view: 'profile' })}
          onOpenRequestLogs={() => props.onNavigate({ workspace: 'family', view: 'modelUsageRequests' })}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <FamilySettings
        family={props.family}
        isLoading={!props.family}
        errorMessage={props.familyQueryError instanceof Error ? props.familyQueryError.message : null}
        members={props.members}
        currentUser={props.currentUser}
        membership={props.membership}
        isOwner={props.isOwner}
        familyHeroImageUrl={props.familyHeroImageUrl}
        familyStatCards={props.familyStatCards}
        currentUserRecentLogs={props.currentUserRecentLogs}
        familyOwnerMember={props.familyOwnerMember}
        activityQuery={props.activityQuery}
        activityPhase={props.activityPhase}
        isPhoneViewport={props.isPhoneViewport}
        notificationCenter={props.notificationCenter}
        overlayMode={props.overlayMode}
        editingMember={props.editingMember}
        inviteForm={props.inviteForm}
        profileForm={props.profileForm}
        memberEditForm={props.memberEditForm}
        passwordForm={props.passwordForm}
        familyForm={props.familyForm}
        isCreatingMember={props.isCreatingMember}
        isUpdatingProfile={props.isUpdatingProfile}
        isUpdatingMember={props.isUpdatingMember}
        isUpdatingPassword={props.isUpdatingPassword}
        isUpdatingFamily={props.isUpdatingFamily}
        familyFormError={props.familyFormError}
        profileImageControls={props.profileImageControls}
        familyImageControls={props.familyImageControls}
        resolveAssetUrl={props.resolveAssetUrl}
        onOverlayChange={props.onOverlayChange}
        onNavigate={props.onNavigate}
        onMemberEdit={props.onMemberEdit}
        onInviteFormChange={props.onInviteFormChange}
        onProfileFormChange={props.onProfileFormChange}
        onMemberEditFormChange={props.onMemberEditFormChange}
        onPasswordFormChange={props.onPasswordFormChange}
        onFamilyFormChange={props.onFamilyFormChange}
        onInviteSubmit={props.onInviteSubmit}
        onProfileSubmit={props.onProfileSubmit}
        onMemberEditSubmit={props.onMemberEditSubmit}
        onPasswordSubmit={props.onPasswordSubmit}
        onFamilySubmit={props.onFamilySubmit}
      />
    </Suspense>
  );
}
