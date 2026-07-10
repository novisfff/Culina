import type { FormEventHandler } from 'react';
import type { FamilyDetail, ImageInputValue, Member, UserSummary } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { ActionButton, Avatar, DropdownSelect, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';

export type InviteFormState = {
  username: string;
  displayName: string;
  password: string;
  role: 'Owner' | 'Member';
  email: string;
};

export type MemberEditFormState = {
  memberId: string;
  displayName: string;
  email: string;
  phone: string;
};

export type PasswordFormState = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type ProfileFormState = {
  displayName: string;
  email: string;
  phone: string;
  avatarPrompt: string;
  avatarImages: ImageInputValue;
};

export type FamilyFormState = {
  name: string;
  motto: string;
  location: string;
  foodPreferences: string;
  foodAvoidances: string;
  imagePrompt: string;
  images: ImageInputValue;
};

export type ImageComposerControls = {
  isGenerating: boolean;
  errorMessage?: string | null;
  isPromptOpen: boolean;
  onPromptOpen: () => void;
  onPromptClose: () => void;
  onUploadDirect: (files: FileList | null, alt: string) => void;
  onGenerateText: () => Promise<void> | void;
  onReset: () => void;
};

export function InviteMemberModal(props: {
  form: InviteFormState;
  isSubmitting: boolean;
  onChange: (form: InviteFormState) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}) {
  const inviteFormId = 'family-invite-member-form';
  const isBusy = props.isSubmitting;
  const closeIfAllowed = () => {
    if (!isBusy) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="family-settings-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
    >
      <WorkspaceModal
        title="创建成员账号"
        description="为家庭成员开通登录账号，完成后会立即出现在成员列表中。"
        className="invite-member-modal"
        onClose={closeIfAllowed}
        footerActions={
          <FormActions
            primaryLabel="创建成员账号"
            primaryType="submit"
            primaryForm={inviteFormId}
            isSubmitting={isBusy}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={inviteFormId} className="form-grid compact-grid" onSubmit={props.onSubmit}>
          <label>
            <span>用户名</span>
            <input
              className="text-input"
              value={props.form.username}
              onChange={(event) => props.onChange({ ...props.form, username: event.target.value })}
            />
          </label>
          <label>
            <span>显示名称</span>
            <input
              className="text-input"
              value={props.form.displayName}
              onChange={(event) => props.onChange({ ...props.form, displayName: event.target.value })}
            />
          </label>
          <label>
            <span>初始密码</span>
            <input
              className="text-input"
              type="password"
              value={props.form.password}
              onChange={(event) => props.onChange({ ...props.form, password: event.target.value })}
            />
          </label>
          <label>
            <span>角色</span>
            <DropdownSelect
              ariaLabel="选择成员角色"
              placeholder="选择成员角色"
              value={props.form.role}
              options={[
                { value: 'Member', label: '家庭成员' },
                { value: 'Owner', label: '主理人' },
              ]}
              onChange={(role) => props.onChange({ ...props.form, role: role as 'Owner' | 'Member' })}
            />
          </label>
          <label className="span-two">
            <span>邮箱</span>
            <input
              className="text-input"
              type="email"
              value={props.form.email}
              onChange={(event) => props.onChange({ ...props.form, email: event.target.value })}
            />
          </label>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export function MemberEditModal(props: {
  member: Member;
  form: MemberEditFormState;
  isSubmitting: boolean;
  onChange: (form: MemberEditFormState) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}) {
  const memberEditFormId = 'family-member-edit-form';
  const isBusy = props.isSubmitting;
  const closeIfAllowed = () => {
    if (!isBusy) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="family-settings-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
    >
      <WorkspaceModal
        title="修改成员信息"
        description="管理员可以维护成员昵称和联系方式，普通成员只能查看这些信息。"
        onClose={closeIfAllowed}
        className="member-edit-modal"
        footerActions={
          <FormActions
            primaryLabel="保存信息"
            primaryType="submit"
            primaryForm={memberEditFormId}
            isSubmitting={isBusy}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={memberEditFormId} className="member-edit-form" onSubmit={props.onSubmit}>
          <section className="member-edit-card">
            <div className="member-edit-preview">
              <Avatar
                label={props.form.displayName || props.member.display_name}
                seed={props.form.displayName || props.member.avatar_seed}
                imageUrl={props.member.avatar_image?.url}
                large
              />
              <div>
                <strong>{props.form.displayName || props.member.display_name}</strong>
                <p>{props.member.role === 'Owner' ? '主理人' : '成员'} · {props.member.username}</p>
              </div>
            </div>
            <div className="member-edit-basic-grid">
              <label>
                <span>显示名称</span>
                <input
                  className="text-input"
                  value={props.form.displayName}
                  onChange={(event) => props.onChange({ ...props.form, displayName: event.target.value })}
                />
              </label>
              <label>
                <span>邮箱</span>
                <input
                  className="text-input"
                  type="email"
                  value={props.form.email}
                  onChange={(event) => props.onChange({ ...props.form, email: event.target.value })}
                />
              </label>
              <label className="member-edit-wide-field">
                <span>手机号</span>
                <input
                  className="text-input"
                  value={props.form.phone}
                  onChange={(event) => props.onChange({ ...props.form, phone: event.target.value })}
                />
              </label>
            </div>
          </section>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export function PasswordChangeModal(props: {
  form: PasswordFormState;
  isSubmitting: boolean;
  onChange: (form: PasswordFormState) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}) {
  const passwordFormId = 'family-password-change-form';
  const isBusy = props.isSubmitting;
  const closeIfAllowed = () => {
    if (!isBusy) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="family-settings-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
    >
      <WorkspaceModal
        title="修改密码"
        description="输入当前密码并设置一个包含字母和数字的新密码。"
        className="password-change-modal"
        onClose={closeIfAllowed}
        footerActions={
          <FormActions
            primaryLabel="修改密码"
            primaryType="submit"
            primaryForm={passwordFormId}
            isSubmitting={isBusy}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={passwordFormId} className="form-grid compact-grid" onSubmit={props.onSubmit}>
          <label className="span-two">
            <span>当前密码</span>
            <input
              className="text-input"
              type="password"
              value={props.form.currentPassword}
              onChange={(event) => props.onChange({ ...props.form, currentPassword: event.target.value })}
            />
          </label>
          <label>
            <span>新密码</span>
            <input
              className="text-input"
              type="password"
              value={props.form.newPassword}
              onChange={(event) => props.onChange({ ...props.form, newPassword: event.target.value })}
            />
          </label>
          <label>
            <span>确认新密码</span>
            <input
              className="text-input"
              type="password"
              value={props.form.confirmPassword}
              onChange={(event) => props.onChange({ ...props.form, confirmPassword: event.target.value })}
            />
          </label>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export function ProfileEditModal(props: {
  form: ProfileFormState;
  currentUser: UserSummary | null;
  roleLabel: string;
  isSubmitting: boolean;
  imageControls: ImageComposerControls;
  resolveAssetUrl: (url?: string) => string | undefined;
  onChange: (form: ProfileFormState) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}) {
  const previewLabel = props.form.displayName || props.currentUser?.display_name || '成员';
  const previewSeed = props.form.displayName || props.currentUser?.avatar_seed || '成员';
  const imageUrl = props.form.avatarImages.generatedAsset?.url ?? props.currentUser?.avatar_image?.url;
  const isBusy = props.isSubmitting;
  const showBottomPreview = !!(
    (props.form.avatarImages.generatedAsset && props.form.avatarImages.generatedAsset.id !== props.currentUser?.avatar_image?.id) ||
    props.imageControls.isGenerating
  );
  const bottomPreviewUrl = props.resolveAssetUrl(props.form.avatarImages.generatedAsset?.url);
  const profileEditFormId = 'family-profile-edit-form';
  const closeIfAllowed = () => {
    if (!isBusy) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="family-settings-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
    >
      <WorkspaceModal
        title="编辑我的资料"
        description="更新联系方式与头像，头像可上传本地图片，也可以按你的说明生成。"
        onClose={closeIfAllowed}
        className="profile-edit-modal"
        footerActions={
          <FormActions
            primaryLabel="保存资料"
            primaryType="submit"
            primaryForm={profileEditFormId}
            isSubmitting={isBusy}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={profileEditFormId} className="profile-edit-form" onSubmit={props.onSubmit}>
          <section className="profile-edit-card">
            <div className="profile-edit-preview">
              <Avatar label={previewLabel} seed={previewSeed} imageUrl={imageUrl} large />
              <div>
                <strong>{props.form.displayName || props.currentUser?.display_name || '家庭成员'}</strong>
                <p>{props.roleLabel} · {props.currentUser?.username}</p>
              </div>
            </div>
            <div className="profile-edit-basic-grid">
              <label>
                <span>显示名称</span>
                <input
                  className="text-input"
                  value={props.form.displayName}
                  onChange={(event) => props.onChange({ ...props.form, displayName: event.target.value })}
                />
              </label>
              <label>
                <span>邮箱</span>
                <input
                  className="text-input"
                  type="email"
                  value={props.form.email}
                  onChange={(event) => props.onChange({ ...props.form, email: event.target.value })}
                />
              </label>
              <label className="profile-edit-wide-field">
                <span>手机号</span>
                <input
                  className="text-input"
                  value={props.form.phone}
                  onChange={(event) => props.onChange({ ...props.form, phone: event.target.value })}
                />
              </label>
            </div>
          </section>
          <section className="profile-avatar-card">
            <div className="profile-avatar-head">
              <div>
                <span>头像图片</span>
                <p>上传本地图片，或按资料和你的说明生成头像。</p>
              </div>
              <div className="profile-avatar-actions">
                <label className="ghost-button profile-avatar-upload-button">
                  上传本地头像
                  <input
                    type="file"
                    accept="image/*,.svg"
                    disabled={props.imageControls.isGenerating}
                    onChange={(event) => {
                      props.imageControls.onUploadDirect(event.target.files, `${props.form.displayName || '成员'}头像`);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={props.imageControls.onPromptOpen}
                  disabled={props.imageControls.isGenerating}
                >
                  基于资料生成头像
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={props.imageControls.onReset}
                  disabled={props.imageControls.isGenerating}
                >
                  清空头像
                </ActionButton>
              </div>
            </div>
            <div className="profile-avatar-body">
              {showBottomPreview && (
                <div
                  className={`profile-avatar-large-preview ${props.form.avatarImages.generatedAsset ? 'has-image' : ''} ${props.imageControls.isGenerating ? 'is-loading' : ''}`}
                >
                  {props.imageControls.isGenerating ? (
                    <div className="profile-avatar-generating-overlay">
                      <div className="profile-avatar-generating-sparkles">
                        <span className="sparkle sparkle-1" />
                        <span className="sparkle sparkle-2" />
                        <span className="sparkle sparkle-3" />
                      </div>
                    </div>
                  ) : (
                    <div className="profile-avatar-preview-mask">
                      <Avatar label={previewLabel} seed={previewSeed} imageUrl={bottomPreviewUrl} large />
                    </div>
                  )}
                  <span>{props.imageControls.isGenerating ? 'AI 后台智能头像生成中...' : props.form.avatarImages.generatedAsset ? '已设置头像' : '当前预览'}</span>
                </div>
              )}
              {props.imageControls.isPromptOpen && (
                <div className="profile-avatar-prompt-panel">
                  <label>
                    <span>你希望头像怎么生成？</span>
                    <textarea
                      className="text-input"
                      rows={3}
                      placeholder="例如：温暖一点的厨房插画头像，绿色围裙，柔和明亮，不要真人照片"
                      value={props.form.avatarPrompt}
                      onChange={(event) => props.onChange({ ...props.form, avatarPrompt: event.target.value })}
                    />
                  </label>
                  <FormActions
                    className="profile-avatar-prompt-actions"
                    primaryLabel="生成头像"
                    primaryDisabled={!props.form.avatarPrompt.trim()}
                    isSubmitting={props.imageControls.isGenerating}
                    secondaryLabel="取消"
                    onPrimary={() => {
                      void Promise.resolve(props.imageControls.onGenerateText()).then(props.imageControls.onPromptClose);
                    }}
                    onSecondary={props.imageControls.onPromptClose}
                  />
                </div>
              )}
            </div>
            {props.imageControls.errorMessage && <span className="image-composer-error">{props.imageControls.errorMessage}</span>}
          </section>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export function FamilyEditModal(props: {
  form: FamilyFormState;
  family?: FamilyDetail | null;
  isSubmitting: boolean;
  validationError?: string | null;
  imageControls: ImageComposerControls;
  resolveAssetUrl: (url?: string) => string | undefined;
  onChange: (form: FamilyFormState) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}) {
  const imageUrl = props.form.images.generatedAsset?.url ?? props.family?.image?.url;
  const resolvedImageUrl = props.resolveAssetUrl(imageUrl);
  const isBusy = props.isSubmitting;
  const showBottomPreview = !!(
    (props.form.images.generatedAsset && props.form.images.generatedAsset.id !== props.family?.image?.id) ||
    props.imageControls.isGenerating
  );
  const bottomPreviewUrl = props.resolveAssetUrl(props.form.images.generatedAsset?.url);
  const familyEditFormId = 'family-edit-form';
  const closeIfAllowed = () => {
    if (!isBusy) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="family-settings-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
    >
      <WorkspaceModal
        title="编辑家庭信息"
        description="维护家庭资料与家庭头像，家庭图可上传本地照片，也可以按说明生成。"
        onClose={closeIfAllowed}
        className="family-edit-modal"
        footerActions={
          <FormActions
            primaryLabel="保存家庭信息"
            primaryType="submit"
            primaryForm={familyEditFormId}
            isSubmitting={isBusy}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={familyEditFormId} className="family-edit-form" onSubmit={props.onSubmit}>
          <section className="family-edit-card">
            <div
              className={`family-edit-preview ${imageUrl ? 'has-image' : ''}`}
              style={resolvedImageUrl ? { backgroundImage: `url(${resolvedImageUrl})` } : undefined}
            >
              <MediaWithPlaceholder src={resolvedImageUrl} alt={props.form.name || '家庭头像'} />
              <div>
                <strong>{props.form.name || props.family?.name || '家庭厨房'}</strong>
                <p>{props.form.location || props.family?.location || '未填写位置'}</p>
              </div>
            </div>
            <div className="family-edit-basic-grid">
              <label>
                <span>家庭名称</span>
                <input
                  className="text-input"
                  value={props.form.name}
                  onChange={(event) => props.onChange({ ...props.form, name: event.target.value })}
                />
              </label>
              <label>
                <span>所在位置</span>
                <input
                  className="text-input"
                  value={props.form.location}
                  onChange={(event) => props.onChange({ ...props.form, location: event.target.value })}
                />
              </label>
              <label className="family-edit-wide-field">
                <span>家庭口号</span>
                <input
                  className="text-input"
                  value={props.form.motto}
                  onChange={(event) => props.onChange({ ...props.form, motto: event.target.value })}
                />
              </label>
              <label className="family-edit-wide-field">
                <span>饮食偏好</span>
                <textarea
                  className="text-input"
                  name="foodPreferences"
                  rows={3}
                  value={props.form.foodPreferences}
                  aria-invalid={Boolean(props.validationError)}
                  aria-describedby={props.validationError ? 'family-food-context-error' : undefined}
                  placeholder="例如：少油、清淡；支持逗号或换行分隔"
                  onChange={(event) => props.onChange({ ...props.form, foodPreferences: event.target.value })}
                />
              </label>
              <label className="family-edit-wide-field">
                <span>忌口与规避</span>
                <textarea
                  className="text-input"
                  name="foodAvoidances"
                  rows={3}
                  value={props.form.foodAvoidances}
                  aria-invalid={Boolean(props.validationError)}
                  aria-describedby={props.validationError ? 'family-food-context-error' : undefined}
                  placeholder="例如：花生、香菜；支持逗号或换行分隔"
                  onChange={(event) => props.onChange({ ...props.form, foodAvoidances: event.target.value })}
                />
              </label>
              {props.validationError ? (
                <p id="family-food-context-error" className="image-composer-error family-edit-wide-field" role="alert">
                  {props.validationError}
                </p>
              ) : null}
            </div>
          </section>
          <section className="family-image-card">
            <div className="family-image-head">
              <div>
                <span>家庭头像</span>
                <p>上传餐桌或厨房照片，或按家庭资料生成一张统一风格头像。</p>
              </div>
              <div className="family-image-actions">
                <label className="ghost-button family-image-upload-button">
                  上传本地家庭图
                  <input
                    type="file"
                    accept="image/*,.svg"
                    disabled={props.imageControls.isGenerating}
                    onChange={(event) => {
                      props.imageControls.onUploadDirect(event.target.files, `${props.form.name || '家庭'}头像`);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={props.imageControls.onPromptOpen}
                  disabled={props.imageControls.isGenerating}
                >
                  基于家庭资料生成
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={props.imageControls.onReset}
                  disabled={props.imageControls.isGenerating}
                >
                  清空家庭图
                </ActionButton>
              </div>
            </div>
            <div className="family-image-body">
              {props.imageControls.isPromptOpen && (
                <div className="family-image-prompt-panel">
                  <label>
                    <span>你希望家庭图怎么生成？</span>
                    <textarea
                      className="text-input"
                      rows={3}
                      placeholder="例如：明亮温暖的家庭餐桌，绿植和早餐，按方形原图生成，不要人物和文字"
                      value={props.form.imagePrompt}
                      onChange={(event) => props.onChange({ ...props.form, imagePrompt: event.target.value })}
                    />
                  </label>
                  <FormActions
                    className="family-image-prompt-actions"
                    primaryLabel="生成家庭图"
                    primaryDisabled={!props.form.imagePrompt.trim()}
                    isSubmitting={props.imageControls.isGenerating}
                    secondaryLabel="取消"
                    onPrimary={() => {
                      void Promise.resolve(props.imageControls.onGenerateText()).then(props.imageControls.onPromptClose);
                    }}
                    onSecondary={props.imageControls.onPromptClose}
                  />
                </div>
              )}
              {showBottomPreview && (
                <div
                  className={`family-image-large-preview ${props.form.images.generatedAsset ? 'has-image' : ''} ${props.imageControls.isGenerating ? 'is-loading' : ''}`}
                >
                  {props.imageControls.isGenerating ? (
                    <div className="family-image-generating-overlay">
                      <div className="family-image-generating-sparkles">
                        <span className="sparkle sparkle-1" />
                        <span className="sparkle sparkle-2" />
                        <span className="sparkle sparkle-3" />
                      </div>
                    </div>
                  ) : (
                    <div className="family-image-preview-mask">
                      <MediaWithPlaceholder
                        src={bottomPreviewUrl}
                        alt={props.form.name || '家庭头像'}
                        className="family-image-preview-media"
                        imageClassName="family-image-preview-media-image"
                      />
                    </div>
                  )}
                  <span>{props.imageControls.isGenerating ? 'AI 后台智能画卷生成中...' : props.form.images.generatedAsset ? '已设置家庭图' : '当前预览'}</span>
                </div>
              )}
            </div>
            {props.imageControls.errorMessage && <span className="image-composer-error">{props.imageControls.errorMessage}</span>}
          </section>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
