import { useEffect, useState, type FormEvent } from 'react';
import type { Food } from '../../api/types';
import type { NoticeState } from '../../hooks/useNotice';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import {
  type AiRenderPayload,
  getMediaIds,
} from '../../lib/aiImages';
import { emptyImages, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import type { LocalMealFoodEntry, MealFormState } from './MealLogComposer';

type CreateMealLogPayload = {
  date: string;
  meal_type: MealFormState['mealType'];
  food_entries: LocalMealFoodEntry[];
  participant_user_ids: string[];
  notes: string;
  mood: string;
  media_ids: string[];
};

function createDefaultMealForm(): MealFormState {
  return {
    date: todayKey(),
    mealType: 'dinner',
    notes: '',
    mood: '满足',
    photos: emptyImages(),
  };
}

function buildMealImagePayload(
  form: MealFormState,
  entries: LocalMealFoodEntry[],
  foods: Array<Pick<Food, 'id' | 'name'>>
): AiRenderPayload {
  return {
    entity_type: 'meal_log',
    title: `${MEAL_TYPE_LABELS[form.mealType]}餐食`,
    notes: form.notes.trim(),
    meal_type: form.mealType,
    food_names: entries
      .map((entry) => foods.find((food) => food.id === entry.food_id)?.name)
      .filter((name): name is string => Boolean(name)),
  };
}

export function useMealLogComposerState(input: {
  foods: Array<Pick<Food, 'id' | 'name'>>;
  memberIds?: string[];
  currentUserId?: string;
  showNotice: (notice: NoticeState) => void;
  createMealLog: (payload: CreateMealLogPayload) => Promise<unknown>;
}) {
  const [entries, setEntries] = useState<LocalMealFoodEntry[]>([]);
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>(
    input.currentUserId ? [input.currentUserId] : []
  );
  const [form, setForm] = useState<MealFormState>(createDefaultMealForm);
  const imagePayload = buildMealImagePayload(form, entries, input.foods);
  const imageComposer = useImageComposer({
    value: form.photos,
    payload: imagePayload,
    onChange: (next) => setForm((current) => ({ ...current, photos: next })),
  });
  const memberIdKey = input.memberIds?.join('|') ?? '';

  useEffect(() => {
    setSelectedParticipants((current) => {
      const valid = input.memberIds
        ? current.filter((id) => input.memberIds?.includes(id))
        : current;
      return valid.length > 0 ? valid : input.currentUserId ? [input.currentUserId] : [];
    });
  }, [input.currentUserId, memberIdKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (entries.length === 0) {
      input.showNotice({ tone: 'warning', title: '还不能记录餐食', message: '至少选择一个食物来记录这一餐。' });
      return;
    }
    try {
      await input.createMealLog({
        date: form.date,
        meal_type: form.mealType,
        food_entries: entries,
        participant_user_ids: selectedParticipants,
        notes: form.notes,
        mood: form.mood,
        media_ids: getMediaIds(form.photos),
      });
      imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      setForm(createDefaultMealForm());
      setEntries([]);
      setSelectedParticipants(input.currentUserId ? [input.currentUserId] : []);
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '保存餐食记录失败',
        message: reason instanceof Error ? reason.message : '保存餐食记录失败',
      });
    }
  }

  function toggleFood(foodId: string, checked: boolean) {
    setEntries((current) => {
      if (checked) {
        return [...current, { food_id: foodId, servings: 1, note: '' }];
      }
      return current.filter((item) => item.food_id !== foodId);
    });
  }

  function updateFood(foodId: string, key: 'servings' | 'note', value: string) {
    setEntries((current) =>
      current.map((item) =>
        item.food_id === foodId
          ? { ...item, [key]: key === 'servings' ? Number(value) : value }
          : item
      )
    );
  }

  function updateParticipant(userId: string, checked: boolean) {
    setSelectedParticipants((current) =>
      checked ? [...current, userId] : current.filter((item) => item !== userId)
    );
  }

  return {
    form,
    setForm,
    entries,
    selectedParticipants,
    imageComposer,
    submit,
    toggleFood,
    updateFood,
    updateParticipant,
  };
}
