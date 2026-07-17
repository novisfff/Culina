import { useEffect, useRef, useState, type FormEvent } from 'react';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, ConfirmDialog, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
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
  const sceneFormId = 'food-scene-form-modal-form';
  const isUpdatingScene = Boolean(props.isUpdatingScene);
  const [openSceneMenuId, setOpenSceneMenuId] = useState<string | null>(null);
  const [pendingDeleteScene, setPendingDeleteScene] = useState<{ id: string; name: string } | null>(null);
  const [deleteRequestSceneId, setDeleteRequestSceneId] = useState<string | null>(null);
  const openSceneMenuRef = useRef<HTMLDivElement | null>(null);
  const wasUpdatingSceneRef = useRef(isUpdatingScene);
  const isManagerBusy = isUpdatingScene || Boolean(deleteRequestSceneId);

  useEffect(() => {
    if (!openSceneMenuId) return;

    function closeMenuOnOutsidePointer(event: PointerEvent) {
      if (!openSceneMenuRef.current?.contains(event.target as Node)) {
        setOpenSceneMenuId(null);
      }
    }

    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpenSceneMenuId(null);
      }
    }

    document.addEventListener('pointerdown', closeMenuOnOutsidePointer);
    document.addEventListener('keydown', closeMenuOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenuOnOutsidePointer);
      document.removeEventListener('keydown', closeMenuOnEscape);
    };
  }, [openSceneMenuId]);

  useEffect(() => {
    if (!props.isSceneManagerOpen || props.sceneFormMode) {
      setOpenSceneMenuId(null);
      setPendingDeleteScene(null);
      setDeleteRequestSceneId(null);
      return;
    }
    if (isManagerBusy) {
      setOpenSceneMenuId(null);
    }
  }, [isManagerBusy, props.isSceneManagerOpen, props.sceneFormMode]);

  useEffect(() => {
    if (
      pendingDeleteScene
      && !isUpdatingScene
      && !props.sceneCards.some((scene) => scene.id === pendingDeleteScene.id)
    ) {
      setPendingDeleteScene(null);
      setDeleteRequestSceneId(null);
    }
  }, [isUpdatingScene, pendingDeleteScene, props.sceneCards]);

  useEffect(() => {
    const wasUpdatingScene = wasUpdatingSceneRef.current;
    wasUpdatingSceneRef.current = isUpdatingScene;
    if (
      wasUpdatingScene
      && !isUpdatingScene
      && deleteRequestSceneId
      && props.sceneCards.some((scene) => scene.id === deleteRequestSceneId)
    ) {
      setDeleteRequestSceneId(null);
    }
  }, [deleteRequestSceneId, isUpdatingScene, props.sceneCards]);

  function closeManagerIfAllowed() {
    if (!isManagerBusy) {
      props.onCloseManager();
    }
  }

  function closeSceneFormIfAllowed() {
    if (!isUpdatingScene) {
      props.onCloseSceneForm();
    }
  }

  return (
    <>
      {props.isSceneManagerOpen && !props.sceneFormMode && (
        <WorkspaceOverlayFrame
          rootClassName="food-workspace-overlay-root"
          onClose={closeManagerIfAllowed}
          closeOnBackdrop={!isManagerBusy}
        >
          <WorkspaceModal
            title="场景管理"
            description="新增常用食物场景，或整理不再使用的场景入口。"
            eyebrow="食物场景"
            onClose={closeManagerIfAllowed}
            className="food-scene-manager-modal"
          >
            <div className="food-scene-manager">
              <div className="food-scene-manager-toolbar">
                <div>
                  <strong>{props.sceneCards.length} 个场景</strong>
                  <span>整理常用入口</span>
                </div>
                <ActionButton tone="primary" type="button" onClick={props.onOpenCreateScene} disabled={isManagerBusy}>
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
                          <MediaWithPlaceholder
                            src={imageUrl}
                            srcSet={buildMediaSrcSet(scene.imageAsset)}
                            sizes={buildMediaSizes('thumb')}
                            alt=""
                          />
                        </div>
                        <div className="food-scene-row-copy">
                          <div className="food-scene-row-titleline">
                            <strong>{scene.name}</strong>
                            <span>{scene.id ? '自定义' : '推荐'}</span>
                          </div>
                          {scene.description && <p>{scene.description}</p>}
                        </div>
                        <div className="food-scene-row-actions">
                          <button
                            type="button"
                            className="food-scene-row-primary-action"
                            disabled={isManagerBusy}
                            onClick={() => props.onOpenEditScene(scene)}
                          >
                            {scene.id ? '编辑' : '创建'}
                          </button>
                          {scene.id && (
                            <div
                              className="food-scene-row-menu-root"
                              ref={openSceneMenuId === scene.id ? openSceneMenuRef : undefined}
                            >
                              <button
                                type="button"
                                className="food-scene-row-more"
                                aria-label={`更多操作：${scene.name}`}
                                aria-haspopup="menu"
                                aria-expanded={openSceneMenuId === scene.id}
                                disabled={isManagerBusy}
                                onClick={() => setOpenSceneMenuId((current) => current === scene.id ? null : scene.id!)}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <circle cx="5" cy="12" r="1.8" />
                                  <circle cx="12" cy="12" r="1.8" />
                                  <circle cx="19" cy="12" r="1.8" />
                                </svg>
                              </button>
                              {openSceneMenuId === scene.id && (
                                <div className="food-scene-row-menu" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="food-scene-row-delete"
                                    onClick={() => {
                                      setOpenSceneMenuId(null);
                                      setPendingDeleteScene({ id: scene.id!, name: scene.name });
                                    }}
                                  >
                                    <FoodUiIcon name="trash" />
                                    <span>删除场景</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="food-scene-empty">
                    <div className="food-scene-empty-icon" aria-hidden="true">
                      <FoodUiIcon name="bowl" />
                    </div>
                    <div>
                      <strong>还没有场景</strong>
                      <span>新建一个常用场景，快速整理食物</span>
                    </div>
                    <ActionButton tone="secondary" type="button" onClick={props.onOpenCreateScene} disabled={isManagerBusy}>
                      <FoodUiIcon name="plus" />
                      <span>新建场景</span>
                    </ActionButton>
                  </div>
                )}
              </div>
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      <ConfirmDialog
        open={Boolean(pendingDeleteScene)}
        title={pendingDeleteScene ? `删除「${pendingDeleteScene.name}」？` : '删除场景？'}
        description="删除后，这个入口将从场景列表中移除。"
        confirmLabel="删除场景"
        tone="danger"
        isSubmitting={isManagerBusy}
        rootClassName="food-scene-delete-confirm-overlay"
        modalClassName="food-scene-delete-confirm-modal"
        onCancel={() => {
          if (!isManagerBusy) setPendingDeleteScene(null);
        }}
        onConfirm={() => {
          if (pendingDeleteScene && !isManagerBusy) {
            setDeleteRequestSceneId(pendingDeleteScene.id);
            props.onDeleteScene(pendingDeleteScene.id);
          }
        }}
      />

      {props.sceneFormMode && (
        <WorkspaceOverlayFrame
          rootClassName="food-workspace-overlay-root"
          onClose={closeSceneFormIfAllowed}
          closeOnBackdrop={!isUpdatingScene}
        >
          <WorkspaceModal
            title={props.sceneFormMode === 'edit' ? '编辑场景' : '新建场景'}
            description="填写名称和说明后，可生成一张统一风格的食物场景封面。"
            eyebrow="食物场景"
            onClose={closeSceneFormIfAllowed}
            className="food-scene-form-modal"
            footerActions={
              <FormActions
                className="food-scene-form-actions"
                primaryLabel={props.sceneFormMode === 'create' ? '创建场景' : '保存场景'}
                primaryType="submit"
                primaryForm={sceneFormId}
                primaryDisabled={!props.sceneDraft.name.trim()}
                isSubmitting={isUpdatingScene}
                secondaryLabel="取消"
                onSecondary={closeSceneFormIfAllowed}
              />
            }
          >
            <form id={sceneFormId} className="food-scene-form" onSubmit={props.onSubmitScene}>
              <div className="food-scene-form-fields">
                <label className="food-scene-input-field">
                  <span>场景名称</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.name}
                    placeholder="场景名称，例如：加班晚餐"
                    disabled={isUpdatingScene}
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, name: event.target.value })}
                  />
                </label>
                <label className="food-scene-input-field">
                  <span>说明</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.description}
                    placeholder="说明，例如：快手、省心、适合工作日"
                    disabled={isUpdatingScene}
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, description: event.target.value })}
                  />
                </label>
                <label className="food-scene-input-field">
                  <span>封面描述</span>
                  <input
                    className="text-input"
                    value={props.sceneDraft.imagePrompt}
                    placeholder="图片描述，例如：一桌轻食晚餐"
                    disabled={isUpdatingScene}
                    onChange={(event) => props.onSceneDraftChange({ ...props.sceneDraft, imagePrompt: event.target.value })}
                  />
                </label>
                <div className="food-scene-cover-editor">
                  <div className={props.sceneDraft.imageAssetUrl ? 'food-scene-cover-preview has-image' : 'food-scene-cover-preview'}>
                    <MediaWithPlaceholder
                      src={props.sceneDraft.imageAssetUrl ? props.resolveFoodAssetUrl(props.sceneDraft.imageAssetUrl) : undefined}
                      alt={props.sceneDraft.name || '场景封面'}
                    />
                  </div>
                  <div className="food-scene-cover-copy">
                    <strong>场景封面</strong>
                    <span>{props.sceneDraft.imageAssetUrl ? '已生成封面，可重新生成或移除。' : '根据名称、说明和图片描述生成统一风格封面。'}</span>
                  </div>
                  <div className="food-scene-cover-actions">
                    <button
                      type="button"
                      disabled={isUpdatingScene || props.sceneImageState.isGenerating || !props.sceneDraft.name.trim()}
                      onClick={props.onGenerateSceneImage}
                    >
                      <FoodUiIcon name="star" />
                      {props.sceneImageState.isGenerating ? '后台生成中' : props.sceneDraft.imageAssetUrl ? '重新生成' : '生成封面'}
                    </button>
                    {props.sceneDraft.imageAssetUrl && (
                      <button
                        className="danger"
                        type="button"
                        disabled={isUpdatingScene}
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
            </form>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}
    </>
  );
}
