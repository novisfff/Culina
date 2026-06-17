import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { IDLE_IMAGE_GENERATION_STATE, useImageComposer } from '../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId, type AiRenderPayload } from '../../lib/aiImages';
import { getImagePreview } from '../../lib/ui';
import type { Ingredient, IngredientExpiryMode, IngredientUnitConversion } from '../../api/types';
import { getIngredientCategoryPreset, INGREDIENT_CATEGORY_PRESETS, type IngredientWorkspaceView } from './workspaceModel';
import {
  buildIngredientForm,
  buildInventoryForm,
  buildUnitPresetOptions,
  clampNumber,
  defaultIngredientForm,
  INVENTORY_STORAGE_PRESETS,
  isCustomChoiceValue,
  parseOptionalNumber,
  parsePositiveNumber,
  resolveClampedDaysValue,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
  sanitizeIngredientUnitConversions,
  type IngredientCreateFormState,
  type InventoryDrawerFormState,
} from './ingredientWorkspaceForms';

type NoticeTone = 'success' | 'warning' | 'danger';

type UseIngredientEditorStateArgs = {
  editingIngredientId: string | null;
  setEditingIngredientId: Dispatch<SetStateAction<string | null>>;
  ingredientForm: IngredientCreateFormState;
  setIngredientForm: Dispatch<SetStateAction<IngredientCreateFormState>>;
  ingredientOptions: Ingredient[];
  setTransientIngredient: Dispatch<SetStateAction<Ingredient | null>>;
  setSelectedIngredientId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceView: Dispatch<SetStateAction<IngredientWorkspaceView>>;
  setInventoryForm: Dispatch<SetStateAction<InventoryDrawerFormState>>;
  setInventoryAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  setOverlayMode: Dispatch<SetStateAction<'inventory' | 'shopping' | 'consume' | 'destroyExpired' | null>>;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
    unit_conversions: IngredientUnitConversion[];
    default_storage: string;
    default_expiry_mode: IngredientExpiryMode;
    default_expiry_days?: number | null;
    default_low_stock_threshold?: number | null;
    notes: string;
    media_ids: string[];
  }) => Promise<Ingredient>;
  updateIngredient: (
    ingredientId: string,
    payload: {
      name: string;
      category: string;
      default_unit: string;
      unit_conversions: IngredientUnitConversion[];
      default_storage: string;
      default_expiry_mode: IngredientExpiryMode;
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
    }
  ) => Promise<Ingredient>;
  showNotice: (notice: { tone: NoticeTone; title: string; message: string }) => void;
  resolveErrorMessage: (reason: unknown, fallback: string) => string;
};

function buildIngredientImagePayload(form: IngredientCreateFormState): AiRenderPayload {
  return {
    entity_type: 'ingredient',
    title: form.name.trim() || '家庭食材',
    category: form.category.trim(),
    notes: form.notes.trim(),
  };
}

export function useIngredientEditorState(args: UseIngredientEditorStateArgs) {
  const [ingredientUnitAdvancedOpen, setIngredientUnitAdvancedOpen] = useState(false);
  const [ingredientCustomCategoryOpen, setIngredientCustomCategoryOpen] = useState(false);

  const ingredientImageComposer = useImageComposer({
    value: args.ingredientForm.images,
    payload: buildIngredientImagePayload(args.ingredientForm),
    onChange: (next) => args.setIngredientForm((current) => ({ ...current, images: next })),
  });

  function openCreateView() {
    args.setEditingIngredientId(null);
    args.setIngredientForm(defaultIngredientForm());
    setIngredientUnitAdvancedOpen(false);
    setIngredientCustomCategoryOpen(false);
    ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    args.setWorkspaceView('create');
  }

  function openEditView(ingredient: Ingredient) {
    args.setEditingIngredientId(ingredient.id);
    args.setSelectedIngredientId(ingredient.id);
    args.setIngredientForm(buildIngredientForm(ingredient));
    setIngredientUnitAdvancedOpen((ingredient.unit_conversions?.length ?? 0) > 0);
    setIngredientCustomCategoryOpen(false);
    ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    args.setWorkspaceView('create');
  }

  function goBackFromIngredientForm() {
    if (args.editingIngredientId) {
      args.setSelectedIngredientId(args.editingIngredientId);
      args.setWorkspaceView('detail');
      return;
    }
    args.setWorkspaceView('hub');
  }

  function applyIngredientCategoryPreset(category: string) {
    const preset = getIngredientCategoryPreset(category);
    args.setIngredientForm((current) => ({
      ...current,
      category,
      defaultUnit: preset?.defaultUnit ?? current.defaultUnit,
      defaultStorage: preset?.defaultStorage ?? current.defaultStorage,
    }));
  }

  async function submitIngredient(restockAfterSave: boolean) {
    if (args.isCreatingIngredient || args.isUpdatingIngredient) {
      return;
    }
    if (!args.ingredientForm.name.trim()) {
      return;
    }
    const defaultExpiryDays =
      args.ingredientForm.defaultExpiryMode === 'days'
        ? clampNumber(parsePositiveNumber(args.ingredientForm.defaultExpiryDays) ?? 0, 1, 30)
        : null;
    const lowStockThreshold = parseOptionalNumber(args.ingredientForm.defaultLowStockThreshold);
    if (args.ingredientForm.defaultExpiryMode === 'days' && !parsePositiveNumber(args.ingredientForm.defaultExpiryDays)) {
      args.showNotice({
        tone: 'warning',
        title: '还不能保存食材',
        message: '请先填写默认保质期天数，方便以后补库存时自动带出到期建议。',
      });
      return;
    }
    if (lowStockThreshold !== null && lowStockThreshold <= 0) {
      args.showNotice({
        tone: 'warning',
        title: '低库存提醒无效',
        message: '默认低库存提醒值需要大于 0；如果不需要提醒，请切换为不提醒。',
      });
      return;
    }

    try {
      const unitConversions = sanitizeIngredientUnitConversions(
        args.ingredientForm.defaultUnit,
        args.ingredientForm.unitConversions
      );
      const payload = {
        name: args.ingredientForm.name.trim(),
        category: args.ingredientForm.category.trim() || '未分类',
        default_unit: args.ingredientForm.defaultUnit.trim() || '个',
        unit_conversions: unitConversions,
        default_storage: args.ingredientForm.defaultStorage.trim() || '冷藏',
        default_expiry_mode: args.ingredientForm.defaultExpiryMode,
        default_expiry_days: defaultExpiryDays,
        default_low_stock_threshold: lowStockThreshold,
        notes: args.ingredientForm.notes.trim(),
        media_ids: getMediaIds(args.ingredientForm.images),
        pending_image_job_id: getPendingImageJobId(args.ingredientForm.images),
      };
      const saved = args.editingIngredientId
        ? await args.updateIngredient(args.editingIngredientId, payload)
        : await args.createIngredient(payload);
      if (!args.editingIngredientId) {
        args.setTransientIngredient(saved);
      }
      ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      args.setIngredientForm(defaultIngredientForm());
      setIngredientUnitAdvancedOpen(false);
      setIngredientCustomCategoryOpen(false);
      args.setEditingIngredientId(null);
      args.setSelectedIngredientId(saved.id);
      args.setWorkspaceView('detail');
      if (restockAfterSave) {
        args.setInventoryForm(
          buildInventoryForm([saved, ...args.ingredientOptions], saved.id, {
            ingredientLocked: true,
          })
        );
        args.setInventoryAdvancedOpen(false);
        args.setOverlayMode('inventory');
      }
    } catch (reason) {
      args.showNotice({
        tone: 'danger',
        title: args.editingIngredientId ? '更新食材失败' : '新增食材失败',
        message: args.resolveErrorMessage(reason, args.editingIngredientId ? '更新食材失败' : '新增食材失败'),
      });
    }
  }

  function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitIngredient(true);
  }

  const isEditingIngredient = Boolean(args.editingIngredientId);
  const trimmedIngredientName = args.ingredientForm.name.trim();
  const trimmedIngredientCategory = args.ingredientForm.category.trim();
  const trimmedIngredientUnit = args.ingredientForm.defaultUnit.trim();
  const trimmedIngredientStorage = args.ingredientForm.defaultStorage.trim();
  const ingredientVisibleCategoryPresets = INGREDIENT_CATEGORY_PRESETS.slice(0, 5);
  const ingredientCategoryIsVisiblePreset = ingredientVisibleCategoryPresets.some(
    (item) => item.label === trimmedIngredientCategory
  );
  const showIngredientCategoryCustomInput =
    ingredientCustomCategoryOpen || (Boolean(trimmedIngredientCategory) && !ingredientCategoryIsVisiblePreset);
  const ingredientDefaultExpiryDays = parseOptionalNumber(args.ingredientForm.defaultExpiryDays);
  const ingredientDefaultExpiryRangeValue = resolveClampedDaysValue(args.ingredientForm.defaultExpiryDays);
  const ingredientUnitOptions = buildUnitPresetOptions(args.ingredientForm.defaultUnit);
  const ingredientUsesCustomUnit = isCustomChoiceValue(args.ingredientForm.defaultUnit, ingredientUnitOptions);
  const ingredientUsesCustomStorage = !INVENTORY_STORAGE_PRESETS.includes(
    args.ingredientForm.defaultStorage as (typeof INVENTORY_STORAGE_PRESETS)[number]
  );
  const ingredientLowStockEnabled = Boolean(args.ingredientForm.defaultLowStockThreshold.trim());
  const ingredientLowStockValue =
    parsePositiveNumber(args.ingredientForm.defaultLowStockThreshold) ??
    resolveTouchDefaultValue(args.ingredientForm.defaultUnit || '个', 'threshold');
  const ingredientLowStockStep = resolveTouchStep(args.ingredientForm.defaultUnit || '个');
  const ingredientLowStockQuickValues = resolveTouchQuickValues(args.ingredientForm.defaultUnit || '个', 'threshold');
  const ingredientRulesValid =
    args.ingredientForm.defaultExpiryMode !== 'days' || (ingredientDefaultExpiryDays !== null && ingredientDefaultExpiryDays > 0);
  const ingredientHasGeneratedImage = getMediaIds(args.ingredientForm.images).length > 0;
  const ingredientHasReferenceImage = Boolean(args.ingredientForm.images.referenceAsset);
  const ingredientPreviewImage = getImagePreview(args.ingredientForm.images);
  const createCanSubmit =
    Boolean(trimmedIngredientName) &&
    ingredientRulesValid &&
    !args.isCreatingIngredient &&
    !args.isUpdatingIngredient;
  const createSummaryItems = [
    { label: '名称', value: trimmedIngredientName || '未填写食材名称' },
    { label: '分类', value: trimmedIngredientCategory || '未设置分类' },
    { label: '默认位置', value: trimmedIngredientStorage || '未设置位置' },
    {
      label: '默认保质期',
      value:
        args.ingredientForm.defaultExpiryMode === 'days'
          ? ingredientDefaultExpiryDays
            ? `买后 ${ingredientDefaultExpiryDays} 天`
            : '待设置天数'
          : args.ingredientForm.defaultExpiryMode === 'manual_date'
            ? '录入包装日期'
            : '不跟踪到期',
    },
    {
      label: '图片',
      value: ingredientHasGeneratedImage
        ? 'AI 主图已就绪'
        : ingredientHasReferenceImage
          ? '已上传参考图，待生成主图'
          : '暂未生成主图',
    },
  ];
  const createChecklistItems = [
    { label: '已填写食材名称', done: Boolean(trimmedIngredientName) },
    { label: '已选择或输入分类', done: Boolean(trimmedIngredientCategory) },
    { label: '已设置常用单位', done: Boolean(trimmedIngredientUnit) },
    {
      label: '已补充默认保质期规则（可选）',
      done: args.ingredientForm.defaultExpiryMode !== 'days' || Boolean(ingredientDefaultExpiryDays),
      optional: true,
    },
    { label: '已生成 AI 主图（可选）', done: ingredientHasGeneratedImage, optional: true },
  ];

  return {
    ingredientForm: args.ingredientForm,
    setIngredientForm: args.setIngredientForm,
    ingredientUnitAdvancedOpen,
    setIngredientUnitAdvancedOpen,
    ingredientCustomCategoryOpen,
    setIngredientCustomCategoryOpen,
    ingredientImageComposer,
    openCreateView,
    openEditView,
    goBackFromIngredientForm,
    applyIngredientCategoryPreset,
    submitIngredient,
    handleCreateSubmit,
    isEditingIngredient,
    trimmedIngredientName,
    trimmedIngredientCategory,
    trimmedIngredientUnit,
    ingredientVisibleCategoryPresets,
    ingredientCategoryIsVisiblePreset,
    showIngredientCategoryCustomInput,
    ingredientDefaultExpiryDays,
    ingredientDefaultExpiryRangeValue,
    ingredientUnitOptions,
    ingredientUsesCustomUnit,
    ingredientUsesCustomStorage,
    ingredientLowStockEnabled,
    ingredientLowStockValue,
    ingredientLowStockStep,
    ingredientLowStockQuickValues,
    ingredientPreviewImage,
    createCanSubmit,
    createSummaryItems,
    createChecklistItems,
  };
}
