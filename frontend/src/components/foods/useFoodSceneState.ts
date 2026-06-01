import { useMemo, useState, type FormEvent } from 'react';
import type { Food, FoodScene } from '../../api/types';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
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
    payload: buildFoodSceneImagePayload(sceneDraft),
    onChange: (next) =>
      setSceneDraft((current) => ({
        ...current,
        imageAssetId: next.generatedAsset?.id,
        imageAssetUrl: next.generatedAsset?.url,
      })),
    generateErrorMessage: '场景封面生成失败',
  });

  function openCreateScene(name = '') {
    setSceneDraft(blankFoodSceneDraft(name));
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    setSceneFormMode('create');
    setIsSceneManagerOpen(true);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setSceneDraft(blankFoodSceneDraft());
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
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
    sceneImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
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
      sceneImageComposer.setState({ isGenerating: false, errorMessage: '请先填写场景名称。' });
      return;
    }
    const nextDraft = {
      ...sceneDraft,
      name,
      description: sceneDraft.description.trim(),
      imagePrompt: sceneDraft.imagePrompt.trim(),
    };
    setSceneDraft(nextDraft);
    await sceneImageComposer.generate('text', buildFoodSceneImagePayload(nextDraft));
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
    sceneImageState: sceneImageComposer.state,
    setIsSceneManagerOpen,
    setSceneDraft,
    submitScene,
  };
}
