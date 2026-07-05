import type { FormEvent } from 'react';
import { resolveAssetUrl } from '../../lib/assets';
import type { ImageGenerationUiState } from '../../hooks/useImageComposer';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, FormActions, WorkspaceModal } from '../ui-kit';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import type { ManagedRecipeScene, RecipeSceneCard, RecipeSceneFormMode } from './RecipeWorkspaceModel';

type RecipeSceneManagerDialogProps = {
  categoryCards: RecipeSceneCard[];
  managedScenes: ManagedRecipeScene[];
  sceneFormMode: RecipeSceneFormMode;
  editingSceneName: string | null;
  sceneDraft: ManagedRecipeScene;
  sceneImageState: ImageGenerationUiState;
  generatingSceneName: string | null;
  isUpdatingScene?: boolean;
  onClose: () => void;
  onOpenCreateForm: () => void;
  onCloseForm: () => void;
  onChangeDraft: (draft: ManagedRecipeScene) => void;
  onSubmitDraft: (event: FormEvent<HTMLFormElement>) => void;
  onGenerateImage: (scene: ManagedRecipeScene) => void;
  onOpenEditForm: (scene: RecipeSceneCard) => void;
  onDeleteScene: (sceneName: string) => void;
  onRestoreScene: (sceneName: string) => void;
};

export function RecipeSceneManagerDialog(props: RecipeSceneManagerDialogProps) {
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title="场景管理"
        description="场景管理已迁移到食物页。"
        eyebrow="菜谱场景"
        onClose={props.onClose}
        className="recipe-scene-modal"
      >
        <div className="recipe-scene-manager">
          <div className="recipe-scene-manager-toolbar">
            <ActionButton tone="primary" type="button" onClick={props.onOpenCreateForm}>
              新增场景
            </ActionButton>
          </div>
          {props.sceneFormMode && (
            <form className="recipe-scene-form" onSubmit={props.onSubmitDraft}>
              <div className="recipe-scene-form-head">
                <strong>{props.sceneFormMode === 'edit' ? `编辑场景：${props.editingSceneName}` : '新增场景'}</strong>
                <button type="button" onClick={props.onCloseForm}>
                  收起
                </button>
              </div>
              <div className="recipe-scene-form-left">
                <label className="recipe-scene-input-field">
                  <span><RecipeUiIcon name="filter" /></span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.name}
                    placeholder="场景名称，例如：减脂晚餐"
                    onChange={(event) => props.onChangeDraft({ ...props.sceneDraft, name: event.target.value })}
                  />
                </label>
                <label className="recipe-scene-input-field">
                  <span><RecipeUiIcon name="view" /></span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.description}
                    placeholder="信息说明，例如：清爽高蛋白"
                    onChange={(event) => props.onChangeDraft({ ...props.sceneDraft, description: event.target.value })}
                  />
                </label>
                <label className="recipe-scene-input-field">
                  <span><RecipeUiIcon name="sparkle" /></span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.imagePrompt}
                    placeholder="图片描述，例如：清爽的减脂晚餐餐盘"
                    onChange={(event) => props.onChangeDraft({ ...props.sceneDraft, imagePrompt: event.target.value })}
                  />
                </label>
                <FormActions
                  className="recipe-scene-form-actions"
                  primaryLabel={(
                    <>
                      <span aria-hidden="true">+</span>
                      {props.sceneFormMode === 'edit' ? '保存场景' : '添加场景'}
                    </>
                  )}
                  primaryType="submit"
                  primaryDisabled={Boolean(props.isUpdatingScene)}
                  isSubmitting={Boolean(props.isUpdatingScene)}
                />
              </div>
              <div className="recipe-scene-image-panel">
                <button
                  className={props.sceneDraft.imageAssetUrl ? 'recipe-scene-generate-card has-image' : 'recipe-scene-generate-card'}
                  type="button"
                  disabled={props.sceneImageState.isGenerating || !props.sceneDraft.name.trim()}
                  onClick={() => props.onGenerateImage(props.sceneDraft)}
                >
                  {props.sceneDraft.imageAssetUrl ? (
                    <MediaWithPlaceholder
                      src={resolveAssetUrl(props.sceneDraft.imageAssetUrl)}
                      alt={props.sceneDraft.name || '场景图片'}
                    />
                  ) : (
                    <>
                      <span className="recipe-scene-generate-visual"><RecipeUiIcon name="sparkle" /></span>
                      <strong>{props.sceneImageState.isGenerating && props.generatingSceneName === props.sceneDraft.name.trim() ? '后台生成中' : 'AI 生成图片'}</strong>
                      <small>根据描述生成场景配图</small>
                    </>
                  )}
                </button>
                {props.sceneDraft.imageAssetUrl && (
                  <button className="recipe-scene-remove-image" type="button" onClick={() => props.onChangeDraft({ ...props.sceneDraft, imageAssetId: undefined, imageAssetUrl: undefined })}>
                    移除图片
                  </button>
                )}
                {!props.sceneDraft.name.trim() && (
                  <small className="recipe-scene-image-hint">填写场景名称后可生成图片</small>
                )}
                {props.sceneImageState.errorMessage && (
                  <p className="image-composer-error recipe-scene-error">{props.sceneImageState.errorMessage}</p>
                )}
              </div>
            </form>
          )}

          <div className="recipe-scene-list">
            {props.categoryCards.length > 0 ? (
              props.categoryCards.map((scene) => (
                <article key={scene.name} className="recipe-scene-row">
                  <div className="recipe-scene-row-thumb">
                    {scene.imageAssetUrl ? (
                      <MediaWithPlaceholder src={resolveAssetUrl(scene.imageAssetUrl)} alt="" />
                    ) : (
                      <RecipeUiIcon name="sparkle" />
                    )}
                  </div>
                  <div>
                    <strong>{scene.name}</strong>
                    <span>{scene.description || `${scene.count} 道菜谱`}</span>
                  </div>
                  <div className="recipe-scene-row-actions">
                    <button type="button" onClick={() => props.onOpenEditForm(scene)}>
                      编辑
                    </button>
                    <button type="button" onClick={() => props.onDeleteScene(scene.name)} disabled={props.isUpdatingScene}>删除</button>
                  </div>
                </article>
              ))
            ) : (
              <p className="subtle">暂无可管理场景。</p>
            )}
            {props.managedScenes.filter((scene) => scene.hidden).map((scene) => (
              <article key={scene.name} className="recipe-scene-row muted">
                <div className="recipe-scene-row-thumb"><RecipeUiIcon name="leaf" /></div>
                <div>
                  <strong>{scene.name}</strong>
                  <span>已隐藏</span>
                </div>
                <button type="button" onClick={() => props.onRestoreScene(scene.name)} disabled={props.isUpdatingScene}>恢复</button>
              </article>
            ))}
          </div>
        </div>
      </WorkspaceModal>
    </div>
  );
}
