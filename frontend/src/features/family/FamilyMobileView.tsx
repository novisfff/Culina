import type { ActivityLog, Member, MembershipSummary, UserSummary } from '../../api/types';
import type { ReactNode } from 'react';
import { DashboardIcon, ShellIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { Avatar } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import type { FamilyOverlayMode, FamilyStatCard } from './FamilySettings';

export function FamilyMobileView(props: {
  familyName?: string;
  familyMotto?: string;
  familyLocation?: string;
  familyHeroImageUrl?: string;
  members: Member[];
  currentUser: UserSummary | null;
  membership?: MembershipSummary | null;
  isOwner: boolean;
  familyStatCards: FamilyStatCard[];
  familyOwnerMember?: Member;
  activityLogs: ActivityLog[];
  activityPhase?: 'loading' | 'empty' | 'ready' | 'error';
  onActivityRetry?: () => void;
  notificationCenter?: ReactNode;
  resolveAssetUrl: (url?: string) => string | undefined;
  onOverlayChange: (mode: FamilyOverlayMode) => void;
  onNavigate: (tab: 'ingredients' | 'logs') => void;
  onActivityViewerOpen: () => void;
  onMemberEdit: (member: Member) => void;
}) {
  return (
    <section className="mobile-family-page" aria-label="手机家庭页">
      <div className="mobile-family-topbar">
        <div className="mobile-family-brand">
          <span className="mobile-family-logo">
            <ShellIcon name="logo" />
          </span>
          <span>
            <strong>Culina</strong>
            <small>家庭厨房工作台</small>
          </span>
        </div>
        <div className="mobile-family-top-actions">
          {props.notificationCenter}
          <button type="button" aria-label="编辑我的资料" onClick={() => props.onOverlayChange('profile')}>
            <DashboardIcon name="more" />
          </button>
        </div>
      </div>

      <header className="mobile-family-hero">
        <div className="mobile-family-cover">
          <MediaWithPlaceholder
            src={props.resolveAssetUrl(props.familyHeroImageUrl)}
            alt={props.familyName ?? '家庭厨房'}
          />
        </div>
        <div className="mobile-family-hero-copy">
          <h1>{props.familyName ?? '我的家庭'}</h1>
          <p>{props.familyMotto || '管理家庭成员、权限和协作邀请，让一家人的厨房协作保持同步。'}</p>
          <div className="mobile-family-meta-row" aria-label="家庭信息">
            <span>
              <DashboardIcon name="map-pin" />
              {props.familyLocation || '未填写位置'}
            </span>
            <span>
              <DashboardIcon name="family" />
              {props.members.length} 位成员
            </span>
          </div>
        </div>
        <div className="mobile-family-actions">
          {props.isOwner ? (
            <button className="mobile-family-primary" type="button" onClick={() => props.onOverlayChange('invite')}>
              <DashboardIcon name="plus" />
              邀请成员
            </button>
          ) : (
            <button className="mobile-family-primary" type="button" onClick={() => props.onOverlayChange('profile')}>
              <DashboardIcon name="user-plus" />
              编辑资料
            </button>
          )}
          <button
            className="mobile-family-secondary"
            type="button"
            onClick={() => props.onOverlayChange(props.isOwner ? 'family' : 'password')}
          >
            <DashboardIcon name={props.isOwner ? 'edit' : 'lock'} />
            {props.isOwner ? '家庭资料' : '修改密码'}
          </button>
        </div>
      </header>

      <section className="mobile-family-stat-strip" aria-label="家庭摘要">
        {props.familyStatCards.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              if (item.label === '家庭成员') {
                document.getElementById('mobile-family-members')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              } else if (item.label === '家庭资料') {
                props.onOverlayChange(props.isOwner ? 'family' : 'profile');
              } else if (item.label === '待处理采购') {
                props.onNavigate('ingredients');
              } else {
                document.getElementById('mobile-family-activity')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
            }}
          >
            <span className={`mobile-family-stat-icon tone-${item.tone}`}>
              <DashboardIcon name={item.icon} />
            </span>
            <strong>
              {item.value}
              {item.unit && <small>{item.unit}</small>}
            </strong>
            <span>{item.label}</span>
          </button>
        ))}
      </section>

      {props.currentUser && (
        <section className="mobile-family-panel mobile-family-me-card">
          <div className="mobile-family-section-head">
            <h2>我的账号</h2>
            <button type="button" onClick={() => props.onOverlayChange('profile')}>
              编辑
              <DashboardIcon name="edit" />
            </button>
          </div>
          <div className="mobile-family-me-row">
            <Avatar
              label={props.currentUser.display_name}
              seed={props.currentUser.avatar_seed}
              imageUrl={props.currentUser.avatar_image?.url}
              large
            />
            <div>
              <strong>{props.currentUser.display_name}</strong>
              <span>{props.membership?.role ?? 'Member'} · {props.currentUser.username}</span>
              <small>{props.currentUser.email ?? props.currentUser.phone ?? '还没有联系方式'}</small>
            </div>
          </div>
          <div className="mobile-family-account-actions">
            <button type="button" onClick={() => props.onOverlayChange('profile')}>编辑资料</button>
            <button type="button" onClick={() => props.onOverlayChange('password')}>修改密码</button>
          </div>
        </section>
      )}

      <section id="mobile-family-members" className="mobile-family-panel">
        <div className="mobile-family-section-head">
          <h2>家庭成员 <span>{props.members.length} 人</span></h2>
          {props.isOwner && (
            <button type="button" onClick={() => props.onOverlayChange('invite')}>
              新增
              <DashboardIcon name="plus" />
            </button>
          )}
        </div>
        <div className="mobile-family-member-list">
          {props.members.map((member) => (
            <article key={member.id} className="mobile-family-member-card">
              <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} large />
              <div>
                <strong>{member.display_name}</strong>
                <span>{member.role === 'Owner' ? '主理人' : member.id === props.currentUser?.id ? '这是你' : '成员'} · {member.username}</span>
                <small>{member.email ?? member.phone ?? '等待补充联系信息'}</small>
              </div>
              {props.isOwner ? (
                <button type="button" aria-label={`修改 ${member.display_name} 的信息`} onClick={() => props.onMemberEdit(member)}>
                  <DashboardIcon name="edit" />
                </button>
              ) : (
                <i className={member.role === 'Owner' ? 'owner' : ''}>
                  <DashboardIcon name={member.role === 'Owner' ? 'shield' : 'check'} />
                </i>
              )}
            </article>
          ))}
        </div>
      </section>

      <section id="mobile-family-activity" className="mobile-family-panel">
        <div className="mobile-family-section-head">
          <h2>家庭活动</h2>
          <button type="button" onClick={props.onActivityViewerOpen}>
            全部
            <DashboardIcon name="list" />
          </button>
        </div>
        {props.activityPhase === 'loading' ? (
          <div className="mobile-family-activity-skeleton" aria-label="家庭活动加载中">
            {[0, 1, 2].map((index) => (
              <span key={index} aria-hidden="true" />
            ))}
          </div>
        ) : props.activityPhase === 'error' ? (
          <div className="mobile-family-empty">
            <strong>家庭活动暂时加载失败</strong>
            <span>稍后重试即可继续查看协作动态。</span>
            {props.onActivityRetry && (
              <button type="button" onClick={props.onActivityRetry}>
                重试活动记录
              </button>
            )}
          </div>
        ) : props.activityLogs.length > 0 ? (
          <div className="mobile-family-activity-list">
            {props.activityLogs.slice(0, 4).map((log, index) => (
              <article key={log.id} className="mobile-family-activity-item">
                <span className={`tone-${index % 4}`}>
                  <DashboardIcon name={index % 3 === 0 ? 'edit' : index % 3 === 1 ? 'leaf' : 'cart'} />
                </span>
                <div>
                  <strong>{log.actor_name ?? '家庭成员'} {log.summary}</strong>
                  <small>{formatDateTime(log.created_at)}</small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mobile-family-empty">
            <strong>暂无家庭活动</strong>
            <span>记录餐食、采购和食材后，这里会自动更新。</span>
          </div>
        )}
      </section>

      <section className="mobile-family-panel">
        <div className="mobile-family-section-head">
          <h2>{props.isOwner ? '协作邀请' : '协作权限'}</h2>
        </div>
        {props.isOwner ? (
          <div className="mobile-family-action-list">
            <button type="button" onClick={() => props.onOverlayChange('invite')}>
              <span><DashboardIcon name="link" /></span>
              <strong>邀请成员</strong>
              <small>为家人创建账号并加入厨房协作</small>
            </button>
            <button type="button" onClick={() => props.onOverlayChange('family')}>
              <span><DashboardIcon name="edit" /></span>
              <strong>编辑家庭资料</strong>
              <small>维护家庭名称、位置、口号和家庭图</small>
            </button>
          </div>
        ) : (
          <div className="mobile-family-action-list">
            <button type="button" onClick={() => props.onNavigate('ingredients')}>
              <span><DashboardIcon name="check" /></span>
              <strong>参与厨房协作</strong>
              <small>添加食材、更新采购、记录餐食和查看菜谱</small>
            </button>
            {props.familyOwnerMember && (
              <button type="button" onClick={() => props.onOverlayChange('profile')}>
                <span><DashboardIcon name="shield" /></span>
                <strong>主理人管理家庭资料</strong>
                <small>{props.familyOwnerMember.display_name} · {props.familyOwnerMember.username}</small>
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
