import { useState, type FormEventHandler, type ReactNode } from 'react';
import type { ActivityLog, FamilyDetail, Member, MembershipSummary, UserSummary } from '../../api/types';
import { DashboardIcon, ShellIcon, type DashboardIconName } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { Avatar, Badge, StateBlock, StatusBadge } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import {
  FamilyEditModal,
  InviteMemberModal,
  MemberEditModal,
  PasswordChangeModal,
  ProfileEditModal,
  type FamilyFormState,
  type ImageComposerControls,
  type InviteFormState,
  type MemberEditFormState,
  type PasswordFormState,
  type ProfileFormState,
} from './FamilySettingsModals';
import { FamilyMobileView } from './FamilyMobileView';
import { FamilyActivityMobilePage, FamilyActivityModal } from './FamilyActivityViewer';

export type FamilyOverlayMode = 'invite' | 'profile' | 'password' | 'family' | 'member' | null;

export type FamilyStatCard = {
  label: string;
  value: string | number;
  unit: string;
  detail: string;
  icon: DashboardIconName;
  tone: string;
};

export type FamilySettingsProps = {
  family?: FamilyDetail | null;
  members: Member[];
  currentUser: UserSummary | null;
  membership?: MembershipSummary | null;
  isOwner: boolean;
  familyHeroImageUrl?: string;
  familyStatCards: FamilyStatCard[];
  currentUserRecentLogs: number;
  familyOwnerMember?: Member;
  activityLogs: ActivityLog[];
  isPhoneViewport: boolean;
  notificationCenter?: ReactNode;
  overlayMode: FamilyOverlayMode;
  editingMember?: Member;
  inviteForm: InviteFormState;
  profileForm: ProfileFormState;
  memberEditForm: MemberEditFormState;
  passwordForm: PasswordFormState;
  familyForm: FamilyFormState;
  isCreatingMember: boolean;
  isUpdatingProfile: boolean;
  isUpdatingMember: boolean;
  isUpdatingPassword: boolean;
  isUpdatingFamily: boolean;
  profileImageControls: ImageComposerControls;
  familyImageControls: ImageComposerControls;
  resolveAssetUrl: (url?: string) => string | undefined;
  onOverlayChange: (mode: FamilyOverlayMode) => void;
  onNavigate: (tab: 'ingredients' | 'logs') => void;
  onMemberEdit: (member: Member) => void;
  onInviteFormChange: (form: InviteFormState) => void;
  onProfileFormChange: (form: ProfileFormState) => void;
  onMemberEditFormChange: (form: MemberEditFormState) => void;
  onPasswordFormChange: (form: PasswordFormState) => void;
  onFamilyFormChange: (form: FamilyFormState) => void;
  onInviteSubmit: FormEventHandler<HTMLFormElement>;
  onProfileSubmit: FormEventHandler<HTMLFormElement>;
  onMemberEditSubmit: FormEventHandler<HTMLFormElement>;
  onPasswordSubmit: FormEventHandler<HTMLFormElement>;
  onFamilySubmit: FormEventHandler<HTMLFormElement>;
};

export function FamilySettings(props: FamilySettingsProps) {
  const closeOverlay = () => props.onOverlayChange(null);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);
  const [isMobileActivityPageOpen, setIsMobileActivityPageOpen] = useState(false);

  const openActivityViewer = () => {
    if (props.isPhoneViewport) {
      setIsMobileActivityPageOpen(true);
      return;
    }
    setIsActivityModalOpen(true);
  };

  if (isMobileActivityPageOpen) {
    return (
      <main className="family-workspace">
        <FamilyActivityMobilePage
          members={props.members}
          previewLogs={props.activityLogs}
          onBack={() => setIsMobileActivityPageOpen(false)}
        />
      </main>
    );
  }

  return (
    <main className="family-workspace">
      <FamilyMobileView
        familyName={props.family?.name}
        familyMotto={props.family?.motto}
        familyLocation={props.family?.location}
        familyHeroImageUrl={props.familyHeroImageUrl}
        members={props.members}
        currentUser={props.currentUser}
        membership={props.membership}
        isOwner={props.isOwner}
        familyStatCards={props.familyStatCards}
        familyOwnerMember={props.familyOwnerMember}
        activityLogs={props.activityLogs}
        notificationCenter={props.notificationCenter}
        resolveAssetUrl={props.resolveAssetUrl}
        onOverlayChange={props.onOverlayChange}
        onNavigate={props.onNavigate}
        onActivityViewerOpen={openActivityViewer}
        onMemberEdit={props.onMemberEdit}
      />

      <div className="family-desktop-view">
        <section className="card family-hero">
          <div className="family-hero-head">
            <div className="family-hero-copy">
              <h1>我的家庭</h1>
              <p>
                {props.isOwner
                  ? '管理家庭成员、权限和协作邀请，让一家人的厨房协作保持同步。'
                  : '查看家庭成员、协作权限和自己的账号资料，安心参与厨房日常。'}
              </p>
            </div>
            <div className="family-hero-actions">
              {props.isOwner ? (
                <button className="solid-button family-action-primary" type="button" onClick={() => props.onOverlayChange('invite')}>
                  <DashboardIcon name="plus" />
                  邀请成员
                </button>
              ) : (
                <button className="solid-button family-action-primary" type="button" onClick={() => props.onOverlayChange('profile')}>
                  <DashboardIcon name="user-plus" />
                  编辑我的资料
                </button>
              )}
              {props.isOwner ? (
                <button className="ghost-button family-action-secondary" type="button" onClick={() => props.onOverlayChange('family')}>
                  <DashboardIcon name="edit" />
                  编辑家庭资料
                </button>
              ) : (
                <button className="ghost-button family-action-secondary" type="button" onClick={() => props.onOverlayChange('password')}>
                  <DashboardIcon name="lock" />
                  修改密码
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="card family-profile-panel">
          <div className="family-profile-main-row">
            <div className="family-cover-card">
              <MediaWithPlaceholder
                src={props.resolveAssetUrl(props.familyHeroImageUrl)}
                alt={props.family?.name ?? '家庭厨房'}
              />
            </div>
            <div className="family-profile-copy">
              <h2>{props.family?.name ?? '未设置家庭名称'}</h2>
              <p className="family-location">
                <DashboardIcon name="map-pin" />
                {props.family?.location || '未填写位置'}
              </p>
              <p>{props.family?.motto || '补充一句家庭口号，让厨房工作台更有归属感。'}</p>
              <div className="family-chip-row">
                <Badge>
                  <ShellIcon name="logo" />
                  家庭厨房
                </Badge>
                <Badge>
                  <ShellIcon name="family" />
                  {props.members.length} 位成员
                </Badge>
                {!props.isOwner && (
                  <Badge className="family-role-member">
                    <DashboardIcon name="shield" />
                    普通成员
                  </Badge>
                )}
              </div>
            </div>
            {props.currentUser && (
              <div className="family-owner-panel">
                <Avatar
                  label={props.currentUser.display_name}
                  seed={props.currentUser.avatar_seed}
                  imageUrl={props.currentUser.avatar_image?.url}
                  large
                />
                <div className="family-owner-copy">
                  <h3>{props.currentUser.display_name}</h3>
                  <p>{props.membership?.role ?? 'Member'} · {props.currentUser.username}</p>
                  <span>
                    <DashboardIcon name="mail" />
                    {props.currentUser.email ?? '未填写邮箱'}
                  </span>
                  <span>
                    <DashboardIcon name="link" />
                    {props.currentUser.phone ?? '未填写手机号'}
                  </span>
                </div>
                <div className="family-owner-actions">
                  <button className="ghost-button button-compact" type="button" onClick={() => props.onOverlayChange('profile')}>
                    <DashboardIcon name="user-plus" />
                    编辑资料
                  </button>
                  <button className="ghost-button button-compact" type="button" onClick={() => props.onOverlayChange('password')}>
                    <DashboardIcon name="lock" />
                    修改密码
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="family-stat-grid">
            {props.familyStatCards.map((item) => (
              <article key={item.label} className="family-stat-card">
                <span className={`family-stat-icon tone-${item.tone}`}>
                  <DashboardIcon name={item.icon} />
                </span>
                <div className="family-stat-info">
                  <div className="family-stat-header">
                    <span>{item.label}</span>
                    <strong>
                      {item.value}
                      {item.unit && <small>{item.unit}</small>}
                    </strong>
                  </div>
                  <p>{item.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="family-section">
          <div className="family-section-head">
            <h2>家庭成员</h2>
          </div>
          <div className="family-member-grid">
            {props.members.map((member) => (
              <article key={member.id} className="family-member-card">
                <div className="family-member-main">
                  <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} large />
                  <div className="family-member-copy">
                    <div className="family-member-title">
                      <h3>{member.display_name}</h3>
                      <StatusBadge tone={member.role === 'Owner' ? 'plan' : 'neutral'} className={member.role === 'Owner' ? 'family-role-owner' : 'family-role-member'}>
                        {member.role === 'Owner' ? '主理人' : '成员'}
                      </StatusBadge>
                    </div>
                    <p>{member.username}</p>
                    <span>
                      {member.id === props.currentUser?.id
                        ? `今天记录 ${props.currentUserRecentLogs} 次`
                        : member.email ?? member.phone ?? '等待补充联系信息'}
                    </span>
                  </div>
                </div>
                <div className="family-member-actions">
                  {props.isOwner ? (
                    <button
                      className="ghost-button button-compact"
                      type="button"
                      onClick={() => props.onMemberEdit(member)}
                      title={`修改 ${member.display_name} 的信息`}
                    >
                      <DashboardIcon name="edit" />
                      修改信息
                    </button>
                  ) : (
                    <span className={member.role === 'Owner' ? 'family-member-note owner' : 'family-member-note'}>
                      <DashboardIcon name={member.role === 'Owner' ? 'shield' : 'check'} />
                      {member.role === 'Owner' ? '家庭管理员' : member.id === props.currentUser?.id ? '这是你' : '协作成员'}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="family-bottom-grid">
          <section className="card family-activity-panel">
            <div className="family-section-head">
              <h2>家庭活动</h2>
              <button className="tertiary-button button-compact" type="button" onClick={openActivityViewer}>
                查看全部
              </button>
            </div>
            <div className="family-activity-list">
              {props.activityLogs.slice(0, 4).map((log, index) => (
                <article key={log.id} className="family-activity-item">
                  <span className={`family-activity-icon tone-${index % 4}`}>
                    <DashboardIcon name={index % 3 === 0 ? 'edit' : index % 3 === 1 ? 'leaf' : 'cart'} />
                  </span>
                  <div>
                    <strong>{log.actor_name ?? '家庭成员'} {log.summary}</strong>
                    <p>{formatDateTime(log.created_at)}</p>
                  </div>
                </article>
              ))}
              {props.activityLogs.length === 0 && <StateBlock status="empty" title="暂无家庭活动" description="记录餐食、采购和食材后，这里会自动更新。" />}
            </div>
          </section>

          <section className="card family-invite-panel">
            <div className="family-section-head">
              <h2>{props.isOwner ? '邀请家人一起协作' : '我的协作权限'}</h2>
            </div>
            {props.isOwner ? (
              <div className="family-invite-list">
                <article className="family-invite-option tone-link">
                  <span>
                    <DashboardIcon name="link" />
                  </span>
                  <div>
                    <strong>发送邀请链接</strong>
                    <p>适合已有邮箱或手机号的家人加入</p>
                  </div>
                  <button className="solid-button button-compact" type="button" onClick={() => props.onOverlayChange('invite')}>
                    邀请成员
                  </button>
                </article>
                <article className="family-invite-option tone-account">
                  <span>
                    <DashboardIcon name="user-plus" />
                  </span>
                  <div>
                    <strong>创建家庭成员账号</strong>
                    <p>适合老人、小孩或不方便自行注册的家庭成员</p>
                  </div>
                  <button className="solid-button button-compact" type="button" onClick={() => props.onOverlayChange('invite')}>
                    创建成员账号
                  </button>
                </article>
              </div>
            ) : (
              <div className="family-member-permission-list">
                <article className="family-member-permission-card">
                  <span>
                    <DashboardIcon name="check" />
                  </span>
                  <div>
                    <strong>可以参与厨房协作</strong>
                    <p>添加食材、更新采购、记录餐食、查看菜谱和家庭活动。</p>
                  </div>
                </article>
                <article className="family-member-permission-card muted">
                  <span>
                    <DashboardIcon name="lock" />
                  </span>
                  <div>
                    <strong>家庭资料由主理人管理</strong>
                    <p>成员邀请、家庭名称、位置和权限调整需要管理员处理。</p>
                  </div>
                </article>
                {props.familyOwnerMember && (
                  <article className="family-owner-contact-card">
                    <Avatar
                      label={props.familyOwnerMember.display_name}
                      seed={props.familyOwnerMember.avatar_seed}
                      imageUrl={props.familyOwnerMember.avatar_image?.url}
                    />
                    <div>
                      <strong>{props.familyOwnerMember.display_name}</strong>
                      <p>主理人 · {props.familyOwnerMember.username}</p>
                    </div>
                    <Badge>管理员</Badge>
                  </article>
                )}
              </div>
            )}
            <div className="family-permission-note">
              <span>
                <DashboardIcon name="shield" />
              </span>
              <div>
                <strong>权限说明</strong>
                <p>主理人可管理家庭资料与成员权限；普通成员可参与食材、菜谱与记录协作。</p>
              </div>
            </div>
          </section>
        </div>
      </div>

      {props.overlayMode === 'invite' && (
        <InviteMemberModal
          form={props.inviteForm}
          isSubmitting={props.isCreatingMember}
          onChange={props.onInviteFormChange}
          onSubmit={props.onInviteSubmit}
          onClose={closeOverlay}
        />
      )}

      {props.overlayMode === 'profile' && (
        <ProfileEditModal
          form={props.profileForm}
          currentUser={props.currentUser}
          roleLabel={props.membership?.role ?? 'Member'}
          isSubmitting={props.isUpdatingProfile}
          imageControls={props.profileImageControls}
          resolveAssetUrl={props.resolveAssetUrl}
          onChange={props.onProfileFormChange}
          onSubmit={props.onProfileSubmit}
          onClose={closeOverlay}
        />
      )}

      {props.overlayMode === 'member' && props.isOwner && props.editingMember && (
        <MemberEditModal
          member={props.editingMember}
          form={props.memberEditForm}
          isSubmitting={props.isUpdatingMember}
          onChange={props.onMemberEditFormChange}
          onSubmit={props.onMemberEditSubmit}
          onClose={closeOverlay}
        />
      )}

      {props.overlayMode === 'password' && (
        <PasswordChangeModal
          form={props.passwordForm}
          isSubmitting={props.isUpdatingPassword}
          onChange={props.onPasswordFormChange}
          onSubmit={props.onPasswordSubmit}
          onClose={closeOverlay}
        />
      )}

      {props.overlayMode === 'family' && props.isOwner && (
        <FamilyEditModal
          form={props.familyForm}
          family={props.family}
          isSubmitting={props.isUpdatingFamily}
          imageControls={props.familyImageControls}
          resolveAssetUrl={props.resolveAssetUrl}
          onChange={props.onFamilyFormChange}
          onSubmit={props.onFamilySubmit}
          onClose={closeOverlay}
        />
      )}

      {isActivityModalOpen && (
        <FamilyActivityModal
          members={props.members}
          previewLogs={props.activityLogs}
          onClose={() => setIsActivityModalOpen(false)}
        />
      )}
    </main>
  );
}
