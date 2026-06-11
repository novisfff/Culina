import type { FormEvent } from 'react';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { ActionButton, WorkspaceModal } from '../ui-kit';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import type { FoodSceneCardView, FoodSceneFormMode, ManagedFoodScene } from './useFoodSceneState';

type FoodSceneDialogsProps = {
  isSceneManagerOpen: boolean;
  sceneFormMode: FoodSceneFormMode;
  sceneCards: FoodSceneCardView[];
  sceneDraft: ManagedFoodScene;
  sceneImageState: {
    isGenerating: boolean;
    errorMessage: string | null;
  };
  isUpdatingScene?: boolean;
  onCloseManager: () => void;
  onOpenCreateScene: () => void;
  onOpenEditScene: (scene: FoodSceneCardView) => void;
  onDeleteScene: (sceneId: string) => void;
  onCloseSceneForm: () => void;
  onSubmitScene: (event: FormEvent<HTMLFormElement>) => void;
  onGenerateSceneImage: () => void;
  onSceneDraftChange: (next: ManagedFoodScene) => void;
  resolveFoodAssetUrl: (url: string) => string;
};

export function FoodSceneDialogs(props: FoodSceneDialogsProps) {
  return (
    <>
      {props.isSceneManagerOpen && !props.sceneFormMode && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.onCloseManager} />
          <WorkspaceModal
            title="场景管理"
            description="新增常用食物场景，或整理不再使用的场景入口。"
            eyebrow="食物场景"
            onClose={props.onCloseManager}
            className="food-scene-manager-modal"
          >
            <div className="food-scene-manager">
              <div className="food-scene-manager-toolbar">
                <div>
                  <strong>{props.sceneCards.length} 个场景</strong>
                  <span>整理食物库里的场景入口和封面。</span>
                </div>
                <ActionButton tone="primary" type="button" onClick={props.onOpenCreateScene}>
                  <FoodUiIcon name="plus" />
                  <span>新建场景</span>
                </ActionButton>
              </div>
              <div className="food-scene-list">
                {props.sceneCards.length > 0 ? (
                  props.sceneCards.map((scene) => {
                    const imageUrl = resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? props.resolveFoodAssetUrl(scene.imageUrl) : undefined);
                    return (
                    <article key={scene.name} className="food-scene-row">
                      <div className="food-scene-row-thumb">
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            srcSet={buildMediaSrcSet(scene.imageAsset)}
                            sizes={buildMediaSizes('thumb')}
                            alt=""
                          />
                        ) : <FoodUiIcon name="star" />}
                      </div>
                      <div className="food-scene-row-copy">
                        <div className="food-scene-row-titleline">
                          <strong>{scene.name}</strong>
                          <span>{scene.id ? '自定义' : '推荐'}</span>
                        </div>
                        {scene.description && <p>{scene.description}</p>}
                      </div>
                      <div className="food-scene-row-actions">
                        <button type="button" onClick={() => props.onOpenEditScene(scene)}>
                          {scene.id ? '编辑' : '创建'}
                        </button>
                        {scene.id && (
                          <button type="button" disabled={props.isUpdatingScene} onClick={() => props.onDeleteScene(scene.id!)}>
                            删除
                          </button>
                        )}
                      </div>
                    </article>
                    );
                  })
                ) : (
                  <p className="subtle">暂无可管理场景。</p>
                )}
              </div>
            </div>
          </WorkspaceModal>
        </div>
      )}

      {props.sceneFormMode && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={props.onCloseSceneForm} />
          <WorkspaceModal
            title={props.sceneFormMode === 'edit' ? '编辑场景' : '新建场景'}
            description="填写名称和说明后，可生成一张统一风格的食物场景封面。"
            eyebrow="食物场景"
            onClose={props.onCloseSceneForm}
            className="food-scene-form-modal"
          >
            <form className="food-scene-form" onSubmit={props.onSubmitScene}>
              <div className="food-scene-form-fields">
                <label className="food-scene-input-field">
                  <span>场景名称</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.name}
                    placeholder="场景名称，例如：加班晚餐"
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, name: event.target.value })}
                  />
                </label>
                <label className="food-scene-input-field">
                  <span>说明</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.description}
                    placeholder="说明，例如：快手、省心、适合工作日"
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, description: event.target.value })}
                  />
                </label>
                <label className="food-scene-input-field">
                  <span>封面描述</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.imagePrompt}
                    placeholder="图片描述，例如：一桌轻食晚餐"
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, imagePrompt: event.target.value })}
                  />
                </label>
                <div className="food-scene-cover-editor">
                  <div className={props.sceneDraft.imageAssetUrl ? 'food-scene-cover-preview has-image' : 'food-scene-cover-preview'}>
                    {props.sceneDraft.imageAssetUrl ? (
                      <img src={props.resolveFoodAssetUrl(props.sceneDraft.imageAssetUrl)} alt={props.sceneDraft.name || '场景封面'} />
                    ) : (
                      <FoodUiIcon name="star" />
                    )}
                  </div>
                  <div className="food-scene-cover-copy">
                    <strong>场景封面</strong>
                    <span>{props.sceneDraft.imageAssetUrl ? '已生成封面，可重新生成或移除。' : '根据名称、说明和图片描述生成统一风格封面。'}</span>
                  </div>
                  <div className="food-scene-cover-actions">
                    <button
                      type="button"
                      disabled={props.sceneImageState.isGenerating || !props.sceneDraft.name.trim()}
                      onClick={props.onGenerateSceneImage}
                    >
                      <FoodUiIcon name="star" />
                      {props.sceneImageState.isGenerating ? '生成中...' : props.sceneDraft.imageAssetUrl ? '重新生成' : '生成封面'}
                    </button>
                    {props.sceneDraft.imageAssetUrl && (
                      <button
                        className="danger"
                        type="button"
                        onClick={() => props.onSceneDraftChange({ ...props.sceneDraft, imageAssetId: undefined, imageAssetUrl: undefined })}
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
                {!props.sceneDraft.name.trim() && <small className="food-scene-image-hint">填写场景名称后可生成封面</small>}
                {props.sceneImageState.errorMessage && <p className="image-composer-error recipe-scene-error">{props.sceneImageState.errorMessage}</p>}
              </div>
              <div className="workspace-overlay-actions food-scene-form-actions">
                <ActionButton tone="secondary" type="button" onClick={props.onCloseSceneForm}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isUpdatingScene || props.sceneImageState.isGenerating || !props.sceneDraft.name.trim()}
                >
                  {props.sceneFormMode === 'edit' ? '保存场景' : '添加场景'}
                </ActionButton>
              </div>
            </form>
          </WorkspaceModal>
        </div>
      )}
    </>
  );
}
