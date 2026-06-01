import { useState, type FormEvent } from 'react';
import { IDLE_IMAGE_GENERATION_STATE, useImageComposer } from '../../hooks/useImageComposer';
import { DUPLICATED_TYPE_LABELS } from './RecipeWorkspaceOptions';
import {
  buildSceneImagePayload,
  defaultSceneDraft,
  resolveErrorMessage,
  type ManagedRecipeScene,
  type RecipeNotice,
  type RecipeSceneCard,
} from './RecipeWorkspaceModel';

type UseRecipeSceneStateArgs = {
  managedScenes: ManagedRecipeScene[];
  sceneFilter: string;
  setSceneFilter: (value: string) => void;
  showRecipeNotice: (notice: RecipeNotice) => void;
  createRecipeScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<unknown>;
  updateRecipeScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) => Promise<unknown>;
  deleteRecipeScene: (sceneId: string) => Promise<void>;
};

export function useRecipeSceneState(args: UseRecipeSceneStateArgs) {
  const [isSceneManagerOpen, setIsSceneManagerOpen] = useState(false);
  const [sceneFormMode, setSceneFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingSceneName, setEditingSceneName] = useState<string | null>(null);
  const [sceneDraft, setSceneDraft] = useState<ManagedRecipeScene>(() => defaultSceneDraft());
  const [generatingSceneName, setGeneratingSceneName] = useState<string | null>(null);
  const sceneImageComposer = useImageComposer({
    value: {
      generatedAsset:
        sceneDraft.imageAssetId && sceneDraft.imageAssetUrl
          ? {
              id: sceneDraft.imageAssetId,
              name: sceneDraft.name,
              url: sceneDraft.imageAssetUrl,
              source: 'ai',
              alt: sceneDraft.name,
              created_at: '',
            }
          : undefined,
    },
    payload: buildSceneImagePayload(sceneDraft),
    onChange: (next) =>
      setSceneDraft((current) => ({
        ...current,
        imageAssetId: next.generatedAsset?.id,
        imageAssetUrl: next.generatedAsset?.url,
      })),
    generateErrorMessage: '场景图片生成失败',
  });

  function buildRecipeScenePayload(scene: ManagedRecipeScene) {
    const existingIndex = args.managedScenes.findIndex((item) => item.name === scene.name);
    return {
      name: scene.name.trim(),
      description: scene.description.trim(),
      image_prompt: scene.imagePrompt.trim(),
      image_asset_id: scene.imageAssetId,
      hidden: Boolean(scene.hidden),
      custom: scene.custom ?? true,
      sort_order: existingIndex >= 0 ? existingIndex : args.managedScenes.length,
    };
  }

  function openCreateSceneForm() {
    setSceneFormMode('create');
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openEditSceneForm(scene: RecipeSceneCard) {
    setSceneFormMode('edit');
    setEditingSceneName(scene.name);
    setSceneDraft({
      id: args.managedScenes.find((item) => item.name === scene.name)?.id,
      name: scene.name,
      description: scene.description || '',
      imagePrompt: scene.imagePrompt || `${scene.name} 的家庭厨房场景图`,
      imageAssetId: scene.imageAssetId,
      imageAssetUrl: scene.imageAssetUrl,
      custom: scene.custom ?? true,
    });
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitSceneDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sceneDraft.name.trim();
    if (!name) {
      args.showRecipeNotice({ tone: 'warning', title: '还不能保存场景', message: '请填写场景名称。' });
      return;
    }
    if (DUPLICATED_TYPE_LABELS.has(name)) {
      args.showRecipeNotice({ tone: 'warning', title: '场景名称重复', message: '这个名称会和上方筛选重复，请换一个场景名称。' });
      return;
    }
    const nextScene = {
      name,
      description: sceneDraft.description.trim(),
      imagePrompt: sceneDraft.imagePrompt.trim(),
      imageAssetId: sceneDraft.imageAssetId,
      imageAssetUrl: sceneDraft.imageAssetUrl,
      custom: true,
    };
    const existing = args.managedScenes.find((scene) => scene.name === (editingSceneName ?? name));
    try {
      if (existing?.id) {
        await args.updateRecipeScene(existing.id, buildRecipeScenePayload(nextScene));
      } else {
        await args.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
      closeSceneForm();
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '保存场景失败', message: resolveErrorMessage(reason, '保存场景失败') });
    }
  }

  async function deleteManagedScene(sceneName: string) {
    const existing = args.managedScenes.find((scene) => scene.name === sceneName);
    try {
      if (existing?.id && existing.custom) {
        await args.deleteRecipeScene(existing.id);
      } else if (existing?.id) {
        await args.updateRecipeScene(existing.id, { hidden: true });
      } else {
        await args.createRecipeScene({
          name: sceneName,
          description: '',
          image_prompt: '',
          hidden: true,
          custom: false,
          sort_order: args.managedScenes.length,
        });
      }
      if (args.sceneFilter === sceneName) {
        args.setSceneFilter('all');
      }
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '删除场景失败', message: resolveErrorMessage(reason, '删除场景失败') });
    }
  }

  async function restoreManagedScene(sceneName: string) {
    const existing = args.managedScenes.find((scene) => scene.name === sceneName);
    if (!existing?.id) return;
    try {
      if (existing.custom) {
        await args.updateRecipeScene(existing.id, { hidden: false });
      } else {
        await args.deleteRecipeScene(existing.id);
      }
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '恢复场景失败', message: resolveErrorMessage(reason, '恢复场景失败') });
    }
  }

  async function generateSceneImage(scene: ManagedRecipeScene, options: { draft?: boolean } = {}) {
    const name = scene.name.trim();
    if (!name) {
      args.showRecipeNotice({ tone: 'warning', title: '还不能生成场景图', message: '请先填写场景名称。' });
      return;
    }
    const nextSceneBase: ManagedRecipeScene = {
      ...scene,
      name,
      description: scene.description.trim(),
      imagePrompt: scene.imagePrompt.trim(),
      custom: scene.custom ?? true,
    };
    setGeneratingSceneName(name);
    if (options.draft) {
      setSceneDraft(nextSceneBase);
    }
    try {
      const nextImages = await sceneImageComposer.generateWithResult('text', buildSceneImagePayload(nextSceneBase));
      const generatedAsset = nextImages.generatedAsset;
      if (!generatedAsset) {
        throw new Error('AI 主图生成失败');
      }
      const nextScene: ManagedRecipeScene = {
        ...nextSceneBase,
        imageAssetId: generatedAsset.id,
        imageAssetUrl: generatedAsset.url,
      };
      if (options.draft) {
        setSceneDraft(nextScene);
      } else if (scene.id) {
        await args.updateRecipeScene(scene.id, {
          image_prompt: nextScene.imagePrompt,
          image_asset_id: nextScene.imageAssetId,
          hidden: false,
        });
      } else {
        await args.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
    } catch (reason) {
      sceneImageComposer.setState({ isGenerating: false, errorMessage: resolveErrorMessage(reason, '场景图片生成失败') });
    } finally {
      setGeneratingSceneName(null);
    }
  }

  return {
    isSceneManagerOpen,
    setIsSceneManagerOpen,
    sceneFormMode,
    editingSceneName,
    sceneDraft,
    setSceneDraft,
    sceneImageState: sceneImageComposer.state,
    generatingSceneName,
    openCreateSceneForm,
    openEditSceneForm,
    closeSceneForm,
    submitSceneDraft,
    deleteManagedScene,
    restoreManagedScene,
    generateSceneImage,
  };
}
