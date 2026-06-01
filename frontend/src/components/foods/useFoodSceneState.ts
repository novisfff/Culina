import { useMemo, useState, type FormEvent } from 'react';
import type { Food, FoodScene } from '../../api/types';
import { generateImageFromText } from '../../lib/aiImages';
import {
  IDLE_IMAGE_GENERATION_STATE,
  type ImageGenerationUiState,
} from '../../hooks/useImageComposer';
import { buildFoodSceneImagePayload } from './FoodWorkspaceModel';

export type FoodSceneFormMode = 'create' | 'edit' | null;

export type ManagedFoodScene = {
  id?: string;
  name: string;
  description: string;
  imagePrompt: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  hidden?: boolean;
  custom?: boolean;
};

function blankFoodSceneDraft(name = ''): ManagedFoodScene {
  return { name, description: '', imagePrompt: '', custom: true, hidden: false };
}

function resolveErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

function getFoodSceneTags(food: Food) {
  return food.scene_tags ?? [];
}

export function useFoodSceneState(input: {
  foods: Food[];
  foodScenes: FoodScene[];
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<FoodScene>;
  updateFoodScene: (
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
  ) => Promise<FoodScene>;
  deleteFoodScene: (sceneId: string) => Promise<void>;
}) {
  const [isSceneManagerOpen, setIsSceneManagerOpen] = useState(false);
  const [sceneFormMode, setSceneFormMode] = useState<FoodSceneFormMode>(null);
  const [sceneDraft, setSceneDraft] = useState<ManagedFoodScene>(() => blankFoodSceneDraft());
  const [sceneImageState, setSceneImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);

  const sceneCards = useMemo(() => {
    const counts = new Map<string, number>();
    input.foods.forEach((food) => {
      getFoodSceneTags(food).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    });
    return [
      ...input.foodScenes
        .filter((scene) => !scene.hidden)
        .map((scene) => ({
          id: scene.id,
          name: scene.name,
          description: scene.description,
          imagePrompt: scene.image_prompt,
          imageUrl: scene.image?.url,
          custom: scene.custom,
          count: counts.get(scene.name) ?? 0,
        })),
      ...Array.from(counts.entries())
        .filter(([name]) => !input.foodScenes.some((scene) => scene.name === name))
        .map(([name, count]) => ({ id: '', name, description: '', imagePrompt: '', imageUrl: undefined, custom: true, count })),
    ].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 12);
  }, [input.foodScenes, input.foods]);

  function openCreateScene(name = '') {
    setSceneDraft(blankFoodSceneDraft(name));
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    setSceneFormMode('create');
    setIsSceneManagerOpen(true);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setSceneDraft(blankFoodSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openEditScene(scene: {
    id?: string;
    name: string;
    description?: string;
    imagePrompt?: string;
    imageUrl?: string;
    custom?: boolean;
  }) {
    if (!scene.id) {
      openCreateScene(scene.name);
      return;
    }
    setSceneDraft({
      id: scene.id,
      name: scene.name,
      description: scene.description ?? '',
      imagePrompt: scene.imagePrompt ?? '',
      imageAssetUrl: scene.imageUrl,
      custom: scene.custom ?? true,
      hidden: false,
    });
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    setSceneFormMode('edit');
    setIsSceneManagerOpen(true);
  }

  async function submitScene(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sceneDraft.name.trim();
    if (!name) return;
    const payload = {
      name,
      description: sceneDraft.description.trim(),
      image_prompt: sceneDraft.imagePrompt.trim(),
      image_asset_id: sceneDraft.imageAssetId,
      hidden: false,
      custom: true,
      sort_order: 0,
    };
    if (sceneDraft.id) {
      await input.updateFoodScene(sceneDraft.id, payload);
    } else {
      await input.createFoodScene(payload);
    }
    closeSceneForm();
  }

  async function deleteScene(sceneId: string) {
    await input.deleteFoodScene(sceneId);
    if (sceneDraft.id === sceneId) {
      closeSceneForm();
    }
  }

  async function generateFoodSceneImage() {
    const name = sceneDraft.name.trim();
    if (!name) {
      setSceneImageState({ isGenerating: false, errorMessage: '请先填写场景名称。' });
      return;
    }
    setSceneImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await generateImageFromText(buildFoodSceneImagePayload(sceneDraft));
      const generatedAsset = nextImages.generatedAsset;
      if (!generatedAsset) {
        throw new Error('AI 封面生成失败');
      }
      setSceneDraft((current) => ({
        ...current,
        name,
        description: current.description.trim(),
        imagePrompt: current.imagePrompt.trim(),
        imageAssetId: generatedAsset.id,
        imageAssetUrl: generatedAsset.url,
      }));
      setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setSceneImageState({ isGenerating: false, errorMessage: resolveErrorMessage(reason, '场景封面生成失败') });
    }
  }

  return {
    closeSceneForm,
    deleteScene,
    generateFoodSceneImage,
    isSceneManagerOpen,
    openCreateScene,
    openEditScene,
    sceneCards,
    sceneDraft,
    sceneFormMode,
    sceneImageState,
    setIsSceneManagerOpen,
    setSceneDraft,
    submitScene,
  };
}
