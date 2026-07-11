import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { IDLE_IMAGE_GENERATION_STATE, useImageComposer } from '../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId, type AiRenderPayload } from '../../lib/aiImages';
import { getImagePreview } from '../../lib/ui';
import type {
  ExactTransitionResolution,
  Ingredient,
  IngredientExpiryMode,
  IngredientInventoryState,
  IngredientTrackingModeTransitionRequest,
  IngredientUnitConversion,
  InventoryItem,
  InventoryStatus,
  PresenceTransitionResolution,
} from '../../api/types';
import { getIngredientCategoryPreset, getIngredientEditorCategoryPresets, type IngredientWorkspaceView } from './workspaceModel';
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

type TrackingTransitionDraft = {
  targetMode: NonNullable<Ingredient['quantity_tracking_mode']>;
  profilePayload: {
    name: string;
    category: string;
    default_unit: string;
    quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
    unit_conversions: IngredientUnitConversion[];
    default_storage: string;
    default_expiry_mode: IngredientExpiryMode;
    default_expiry_days?: number | null;
    default_low_stock_threshold?: number | null;
    notes: string;
    media_ids: string[];
    pending_image_job_id?: string | null;
  };
  restockAfterSave: boolean;
  presenceResolution: PresenceTransitionResolution;
  exactResolution: ExactTransitionResolution;
};

type UseIngredientEditorStateArgs = {
  editingIngredientId: string | null;
  setEditingIngredientId: Dispatch<SetStateAction<string | null>>;
  ingredientForm: IngredientCreateFormState;
  setIngredientForm: Dispatch<SetStateAction<IngredientCreateFormState>>;
  ingredientOptions: Ingredient[];
  inventoryItems?: InventoryItem[];
  inventoryStates?: IngredientInventoryState[];
  setTransientIngredient: Dispatch<SetStateAction<Ingredient | null>>;
  setSelectedIngredientId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceView: Dispatch<SetStateAction<IngredientWorkspaceView>>;
  setInventoryForm: Dispatch<SetStateAction<InventoryDrawerFormState>>;
  setInventoryAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  setOverlayMode: Dispatch<SetStateAction<'inventory' | 'shopping' | 'consume' | 'inventoryAction' | null>>;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
    quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
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
      quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
      unit_conversions: IngredientUnitConversion[];
      default_storage: string;
      default_expiry_mode: IngredientExpiryMode;
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
    }
  ) => Promise<Ingredient>;
  transitionIngredientTrackingMode?: (
    ingredientId: string,
    payload: IngredientTrackingModeTransitionRequest
  ) => Promise<Ingredient>;
  /** Optional: run after a successful dual-write (transition + profile) or recovered transition. */
  onTrackingTransitionSettled?: (ingredient: Ingredient) => void | Promise<void>;
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

function remainingQuantity(item: InventoryItem): number {
  if (typeof item.remaining_quantity === 'number') {
    return Math.max(item.remaining_quantity, 0);
  }
  return Math.max(
    Number(item.quantity || 0) - Number(item.consumed_quantity || 0) - Number(item.disposed_quantity || 0),
    0
  );
}

function buildDefaultPresenceResolution(
  ingredient: Ingredient,
  inventoryItems: InventoryItem[]
): PresenceTransitionResolution {
  const physical = inventoryItems.filter(
    (item) => item.ingredient_id === ingredient.id && remainingQuantity(item) > 0
  );
  if (physical.length === 0) {
    return {
      availability_level: 'absent',
      inventory_status: 'fresh',
      purchase_date: null,
      expiry_date: null,
      storage_location: null,
      notes: '',
      mark_inventory_confirmed: false,
    };
  }
  const representative = [...physical].sort((left, right) => {
    const leftExpiry = left.expiry_date || '9999-12-31';
    const rightExpiry = right.expiry_date || '9999-12-31';
    if (leftExpiry !== rightExpiry) return leftExpiry.localeCompare(rightExpiry);
    return left.id.localeCompare(right.id);
  })[0];
  return {
    availability_level: 'present_unknown',
    inventory_status: (representative.status as InventoryStatus) || 'fresh',
    purchase_date: representative.purchase_date || null,
    expiry_date: representative.expiry_date || null,
    storage_location: representative.storage_location || ingredient.default_storage || '常温',
    notes: representative.notes || '',
    mark_inventory_confirmed: false,
  };
}

function buildDefaultExactResolution(
  ingredient: Ingredient,
  state: IngredientInventoryState | null
): ExactTransitionResolution {
  return {
    confirm_absent: true,
    quantity: null,
    unit: ingredient.default_unit || '个',
    inventory_status: null,
    purchase_date: null,
    expiry_date: null,
    storage_location: state?.storage_location || ingredient.default_storage || '常温',
    notes: '',
  };
}

export function useIngredientEditorState(args: UseIngredientEditorStateArgs) {
  const [ingredientUnitAdvancedOpen, setIngredientUnitAdvancedOpen] = useState(false);
  const [ingredientCustomCategoryOpen, setIngredientCustomCategoryOpen] = useState(false);
  const [trackingTransitionDraft, setTrackingTransitionDraft] = useState<TrackingTransitionDraft | null>(null);
  const [trackingTransitionBusy, setTrackingTransitionBusy] = useState(false);
  const [trackingTransitionError, setTrackingTransitionError] = useState<string | null>(null);

  const ingredientImageComposer = useImageComposer({
    value: args.ingredientForm.images,
    payload: buildIngredientImagePayload(args.ingredientForm),
    onChange: (next) => args.setIngredientForm((current) => ({ ...current, images: next })),
  });

  const editingIngredient = useMemo(
    () => args.ingredientOptions.find((item) => item.id === args.editingIngredientId) ?? null,
    [args.editingIngredientId, args.ingredientOptions]
  );
  const inventoryItems = args.inventoryItems ?? [];
  const inventoryStates = args.inventoryStates ?? [];

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
      quantityTrackingMode: preset?.quantityTrackingMode ?? current.quantityTrackingMode,
      defaultLowStockThreshold:
        preset?.quantityTrackingMode === 'not_track_quantity' ? '' : current.defaultLowStockThreshold,
    }));
  }

  function finishIngredientSave(saved: Ingredient, restockAfterSave: boolean) {
    if (!args.editingIngredientId) {
      args.setTransientIngredient(saved);
    }
    ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    args.setIngredientForm(defaultIngredientForm());
    setIngredientUnitAdvancedOpen(false);
    setIngredientCustomCategoryOpen(false);
    setTrackingTransitionDraft(null);
    setTrackingTransitionError(null);
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
  }

  async function submitIngredient(restockAfterSave: boolean) {
    if (args.isCreatingIngredient || args.isUpdatingIngredient || trackingTransitionBusy) {
      return;
    }
    if (!args.ingredientForm.name.trim()) {
      return;
    }
    const defaultExpiryDays =
      args.ingredientForm.defaultExpiryMode === 'days'
        ? clampNumber(parsePositiveNumber(args.ingredientForm.defaultExpiryDays) ?? 0, 1, 30)
        : null;
    const tracksQuantity = args.ingredientForm.quantityTrackingMode !== 'not_track_quantity';
    const lowStockThreshold = tracksQuantity ? parseOptionalNumber(args.ingredientForm.defaultLowStockThreshold) : null;
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

    const unitConversions = sanitizeIngredientUnitConversions(
      args.ingredientForm.defaultUnit,
      args.ingredientForm.unitConversions
    );
    const payload = {
      name: args.ingredientForm.name.trim(),
      category: args.ingredientForm.category.trim() || '未分类',
      default_unit: args.ingredientForm.defaultUnit.trim() || '个',
      quantity_tracking_mode: args.ingredientForm.quantityTrackingMode,
      unit_conversions: unitConversions,
      default_storage: args.ingredientForm.defaultStorage.trim() || '冷藏',
      default_expiry_mode: args.ingredientForm.defaultExpiryMode,
      default_expiry_days: defaultExpiryDays,
      default_low_stock_threshold: lowStockThreshold,
      notes: args.ingredientForm.notes.trim(),
      media_ids: getMediaIds(args.ingredientForm.images),
      pending_image_job_id: getPendingImageJobId(args.ingredientForm.images),
    };

    if (args.editingIngredientId && editingIngredient) {
      const currentMode = editingIngredient.quantity_tracking_mode ?? 'track_quantity';
      const nextMode = args.ingredientForm.quantityTrackingMode;
      if (currentMode !== nextMode) {
        const currentState =
          inventoryStates.find((item) => item.ingredient_id === editingIngredient.id) ?? null;
        setTrackingTransitionDraft({
          targetMode: nextMode,
          profilePayload: payload,
          restockAfterSave,
          presenceResolution: buildDefaultPresenceResolution(editingIngredient, inventoryItems),
          exactResolution: buildDefaultExactResolution(editingIngredient, currentState),
        });
        setTrackingTransitionError(null);
        return;
      }
    }

    try {
      const saved = args.editingIngredientId
        ? await args.updateIngredient(args.editingIngredientId, payload)
        : await args.createIngredient(payload);
      finishIngredientSave(saved, restockAfterSave);
    } catch (reason) {
      args.showNotice({
        tone: 'danger',
        title: args.editingIngredientId ? '更新食材失败' : '新增食材失败',
        message: args.resolveErrorMessage(reason, args.editingIngredientId ? '更新食材失败' : '新增食材失败'),
      });
    }
  }

  function cancelTrackingTransition() {
    if (trackingTransitionBusy) return;
    setTrackingTransitionDraft(null);
    setTrackingTransitionError(null);
  }

  function updatePresenceResolution(patch: Partial<PresenceTransitionResolution>) {
    setTrackingTransitionDraft((current) => {
      if (!current) return current;
      const next = { ...current.presenceResolution, ...patch };
      if (next.availability_level === 'absent') {
        next.purchase_date = null;
        next.expiry_date = null;
        next.storage_location = null;
      } else if (!next.storage_location) {
        next.storage_location = editingIngredient?.default_storage || '常温';
      }
      if (patch.availability_level !== undefined) {
        next.mark_inventory_confirmed = true;
      }
      return { ...current, presenceResolution: next };
    });
  }

  function updateExactResolution(patch: Partial<ExactTransitionResolution>) {
    setTrackingTransitionDraft((current) => {
      if (!current) return current;
      const next = { ...current.exactResolution, ...patch };
      if (patch.confirm_absent === true) {
        next.quantity = null;
        next.unit = null;
        next.inventory_status = null;
        next.purchase_date = null;
        next.expiry_date = null;
        next.storage_location = null;
      } else if (patch.confirm_absent === false) {
        next.unit = next.unit || editingIngredient?.default_unit || '个';
        next.inventory_status = next.inventory_status || 'fresh';
        next.storage_location =
          next.storage_location || editingIngredient?.default_storage || '常温';
      }
      return { ...current, exactResolution: next };
    });
  }

  async function confirmTrackingTransition() {
    if (!trackingTransitionDraft || !args.editingIngredientId || !editingIngredient) {
      return;
    }
    if (!args.transitionIngredientTrackingMode) {
      setTrackingTransitionError('当前版本暂不支持切换数量记录方式，请刷新后重试。');
      return;
    }
    if (trackingTransitionBusy || args.isUpdatingIngredient) {
      return;
    }

    const draft = trackingTransitionDraft;
    const targetMode = draft.targetMode ?? 'track_quantity';
    let transitionPayload: IngredientTrackingModeTransitionRequest;
    if (targetMode === 'not_track_quantity') {
      const resolution = { ...draft.presenceResolution };
      if (resolution.availability_level === 'absent') {
        resolution.purchase_date = null;
        resolution.expiry_date = null;
        resolution.storage_location = null;
      } else if (!resolution.storage_location?.trim()) {
        setTrackingTransitionError('有库存时请填写存放位置。');
        return;
      }
      if (!resolution.mark_inventory_confirmed) {
        // Mode-only defaults must not claim a human confirmation.
        resolution.mark_inventory_confirmed = false;
      }
      const physical = inventoryItems.filter(
        (item) => item.ingredient_id === editingIngredient.id && remainingQuantity(item) > 0
      );
      transitionPayload = {
        expected_ingredient_row_version: editingIngredient.row_version ?? 1,
        target_mode: 'not_track_quantity',
        expected_state_row_version:
          inventoryStates.find((item) => item.ingredient_id === editingIngredient.id)?.row_version ?? null,
        observed_batches: physical.map((item) => ({
          inventory_item_id: item.id,
          expected_row_version: item.row_version,
        })),
        presence_resolution: resolution,
      };
    } else {
      const resolution = { ...draft.exactResolution };
      if (resolution.confirm_absent) {
        resolution.quantity = null;
        resolution.unit = null;
        resolution.inventory_status = null;
        resolution.purchase_date = null;
        resolution.expiry_date = null;
        resolution.storage_location = null;
      } else {
        const quantity = Number(resolution.quantity);
        if (!(quantity > 0)) {
          setTrackingTransitionError('请填写大于 0 的初始库存数量。');
          return;
        }
        if (!resolution.unit?.trim()) {
          setTrackingTransitionError('请填写初始库存单位。');
          return;
        }
        if (!resolution.inventory_status) {
          setTrackingTransitionError('请选择初始库存状态。');
          return;
        }
        if (!resolution.purchase_date) {
          setTrackingTransitionError('请填写采购日期。');
          return;
        }
        if (!resolution.storage_location?.trim()) {
          setTrackingTransitionError('请填写存放位置。');
          return;
        }
        resolution.quantity = quantity;
      }
      const currentState =
        inventoryStates.find((item) => item.ingredient_id === editingIngredient.id) ?? null;
      transitionPayload = {
        expected_ingredient_row_version: editingIngredient.row_version ?? 1,
        target_mode: 'track_quantity',
        expected_state_row_version: currentState?.row_version ?? null,
        observed_batches: [],
        exact_resolution: resolution,
      };
    }

    setTrackingTransitionBusy(true);
    setTrackingTransitionError(null);
    let transitioned: Ingredient | null = null;
    try {
      // Transition first; never silently submit the generic profile update for mode changes.
      transitioned = await args.transitionIngredientTrackingMode(
        args.editingIngredientId,
        transitionPayload
      );
      const applied = transitioned;
      // Transition already applied server-side. Align local editor to the new mode/version
      // before attempting the profile dual-write so a profile failure cannot re-run transition.
      args.setIngredientForm((current) => ({
        ...current,
        quantityTrackingMode: applied.quantity_tracking_mode ?? targetMode,
      }));
      args.setTransientIngredient(applied);
      setTrackingTransitionDraft(null);
      setTrackingTransitionError(null);

      const profilePayload = {
        ...draft.profilePayload,
        quantity_tracking_mode: applied.quantity_tracking_mode ?? targetMode,
      };
      try {
        const saved = await args.updateIngredient(args.editingIngredientId, profilePayload);
        finishIngredientSave(saved, draft.restockAfterSave);
        if (args.onTrackingTransitionSettled) {
          await args.onTrackingTransitionSettled(saved);
        }
        args.showNotice({
          tone: 'success',
          title: '已切换数量记录方式',
          message:
            targetMode === 'not_track_quantity'
              ? '之后会按家庭级有无状态维护这道食材。'
              : '之后会按精确库存批次维护这道食材。',
        });
      } catch (profileReason) {
        // Mode/inventory already switched. Keep the editor open with the transitioned
        // ingredient, clear the draft so retry is profile-only via normal save, and
        // surface a non-blocking profile error (do not re-run transition).
        args.setIngredientForm((current) => ({
          ...buildIngredientForm(applied),
          // Preserve in-progress profile edits the user just submitted.
          name: draft.profilePayload.name || current.name,
          category: draft.profilePayload.category || current.category,
          defaultUnit: draft.profilePayload.default_unit || current.defaultUnit,
          defaultStorage: draft.profilePayload.default_storage || current.defaultStorage,
          defaultExpiryMode: draft.profilePayload.default_expiry_mode || current.defaultExpiryMode,
          defaultExpiryDays:
            draft.profilePayload.default_expiry_days === null ||
            draft.profilePayload.default_expiry_days === undefined
              ? ''
              : String(draft.profilePayload.default_expiry_days),
          defaultLowStockThreshold:
            draft.profilePayload.default_low_stock_threshold === null ||
            draft.profilePayload.default_low_stock_threshold === undefined
              ? ''
              : String(draft.profilePayload.default_low_stock_threshold),
          notes: draft.profilePayload.notes ?? current.notes,
          quantityTrackingMode: applied.quantity_tracking_mode ?? targetMode,
        }));
        if (args.onTrackingTransitionSettled) {
          await args.onTrackingTransitionSettled(applied);
        }
        args.showNotice({
          tone: 'warning',
          title: '数量记录方式已切换，资料未全部保存',
          message: args.resolveErrorMessage(
            profileReason,
            '跟踪方式已生效，但名称等资料保存失败。请直接再点保存，不会重复切换跟踪方式。'
          ),
        });
      }
    } catch (reason) {
      const recovered = transitioned;
      if (recovered) {
        // Transition completed but an unexpected post-transition failure escaped.
        setTrackingTransitionDraft(null);
        args.setTransientIngredient(recovered);
        args.setIngredientForm((current) => ({
          ...current,
          quantityTrackingMode: recovered.quantity_tracking_mode ?? targetMode,
        }));
      }
      setTrackingTransitionError(
        args.resolveErrorMessage(reason, '切换数量记录方式失败，请刷新后重试。')
      );
    } finally {
      setTrackingTransitionBusy(false);
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
  const ingredientVisibleCategoryPresets = getIngredientEditorCategoryPresets();
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
  const tracksQuantity = args.ingredientForm.quantityTrackingMode !== 'not_track_quantity';
  const ingredientLowStockEnabled = tracksQuantity && Boolean(args.ingredientForm.defaultLowStockThreshold.trim());
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
    !args.isUpdatingIngredient &&
    !trackingTransitionBusy;
  const createSummaryItems = [
    { label: '名称', value: trimmedIngredientName || '未填写食材名称' },
    { label: '分类', value: trimmedIngredientCategory || '未设置分类' },
    { label: '数量记录', value: tracksQuantity ? '记录数量' : '只记录有无' },
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
    trackingTransitionDraft,
    trackingTransitionBusy,
    trackingTransitionError,
    cancelTrackingTransition,
    updatePresenceResolution,
    updateExactResolution,
    confirmTrackingTransition,
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
