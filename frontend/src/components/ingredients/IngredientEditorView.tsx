import type { Dispatch, FormEvent, ReactNode, SetStateAction } from 'react';
import { resolveAssetUrl } from '../../lib/assets';
import { normalizeIngredientUnit } from '../../lib/ingredientUnits';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  Badge,
  ComboboxField,
  FormActions,
  ImageComposer,
  OptionChipGroup,
  TouchRangeField,
  TouchStepperField,
  WorkspaceModal,
  WorkspaceOverlayFrame,
  WorkspaceSubpageShell,
} from '../ui-kit';
import type {
  ExactTransitionResolution,
  InventoryAvailabilityLevel,
  InventoryStatus,
  PresenceTransitionResolution,
} from '../../api/types';
import {
  createIngredientUnitConversionDraft,
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  type IngredientCreateFormState,
} from './ingredientWorkspaceForms';

const EXPIRY_DAY_MARKS = [1, 3, 7, 14, 30];

export function IngredientCategoryIcon(props: { name: string }) {
  switch (props.name) {
    case 'vegetable':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 17c6.2-.4 9.6-3.6 10.5-10.3C10.8 7.4 7.4 10.7 7 17Z" />
          <path d="M7 17c2.8-3.4 5.4-5.4 9-7" />
        </svg>
      );
    case 'fruit':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8.2c4.1-2.5 7.1.1 7.1 4.4 0 4.8-3.2 7.2-7.1 7.2s-7.1-2.4-7.1-7.2c0-4.3 3-6.9 7.1-4.4Z" />
          <path d="M12 8.2c-.2-1.7.3-3 1.8-4" />
          <path d="M13.8 5.4c1.3-.6 2.6-.4 3.7.6-1.3.8-2.5.9-3.7-.6Z" />
        </svg>
      );
    case 'meat':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.2 15.8c-2-2.8-.8-7.5 3.1-9.4 4.1-2 8.5-.5 9.1 3 .6 3.2-1.7 7.1-5.5 8.6-2.8 1.1-5.1.2-6.7-2.2Z" />
          <path d="M10.2 13.7c-1-1.4-.4-3.7 1.6-4.6 2-.9 4.1-.2 4.4 1.4.3 1.6-.8 3.5-2.7 4.2-1.4.5-2.5.1-3.3-1Z" />
        </svg>
      );
    case 'fish':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.5 12c2.3-3.2 5.1-4.8 8.4-4.8 2.6 0 4.9 1.2 6.6 3.4" />
          <path d="M4.5 12c2.3 3.2 5.1 4.8 8.4 4.8 2.6 0 4.9-1.2 6.6-3.4" />
          <path d="M19.5 10.6 22 8.8v6.4l-2.5-1.8" />
          <path d="M9.5 8.2c.9 1.2.9 6.4 0 7.6" />
          <path d="M16.2 11.2h.01" />
        </svg>
      );
    case 'egg':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4.5c3.6 0 6.2 4.2 6.2 8.7 0 4-2.4 6.3-6.2 6.3s-6.2-2.3-6.2-6.3c0-4.5 2.6-8.7 6.2-8.7Z" />
          <path d="M9.4 14.4c1.3 1.1 3.9 1.1 5.2 0" />
        </svg>
      );
    case 'tofu':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 8.5 12 5l6 3.5v7L12 19l-6-3.5Z" />
          <path d="M6 8.5 12 12l6-3.5" />
          <path d="M12 12v7" />
        </svg>
      );
    case 'staple':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.2h14c-.4 4.2-2.9 6.3-7 6.3s-6.6-2.1-7-6.3Z" />
          <path d="M7.8 9.4c1.2-1.5 2.6-2.2 4.2-2.2s3 .7 4.2 2.2" />
          <path d="M8.5 15.2h7" />
        </svg>
      );
    case 'dryGoods':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5.5h8l1.4 4v9H6.6v-9Z" />
          <path d="M8 5.5c1.4 1.3 6.6 1.3 8 0" />
          <path d="M9 12h6" />
          <path d="M9 15h4" />
        </svg>
      );
    case 'seasoning':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.2 7.5h5.6" />
          <path d="M10 7.5V5h4v2.5" />
          <path d="M8.4 10.5h7.2l.8 8.5H7.6Z" />
          <path d="M10.2 13.8h3.6" />
          <path d="M10.6 16.2h2.8" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.5 12h.01" />
          <path d="M12 12h.01" />
          <path d="M16.5 12h.01" />
          <circle cx="12" cy="12" r="7" />
        </svg>
      );
  }
}

type TrackingTransitionDraftView = {
  targetMode: IngredientCreateFormState['quantityTrackingMode'];
  presenceResolution: PresenceTransitionResolution;
  exactResolution: ExactTransitionResolution;
};

type IngredientEditorViewProps = {
  activePanelBackLabel: string;
  isEditingIngredient: boolean;
  ingredientForm: IngredientCreateFormState;
  setIngredientForm: Dispatch<SetStateAction<IngredientCreateFormState>>;
  ingredientVisibleCategoryPresets: Array<{ label: string; icon: string }>;
  ingredientCategoryIsVisiblePreset: boolean;
  showIngredientCategoryCustomInput: boolean;
  setIngredientCustomCategoryOpen: (next: boolean) => void;
  applyIngredientCategoryPreset: (category: string) => void;
  ingredientUnitAdvancedOpen: boolean;
  setIngredientUnitAdvancedOpen: (next: boolean) => void;
  ingredientUnitOptions: string[];
  ingredientUsesCustomUnit: boolean;
  ingredientUsesCustomStorage: boolean;
  trimmedIngredientUnit: string;
  ingredientDefaultExpiryRangeValue: number;
  ingredientLowStockEnabled: boolean;
  ingredientLowStockValue: number;
  ingredientLowStockStep: number;
  ingredientLowStockQuickValues: number[];
  ingredientPreviewImage: { url: string; alt?: string } | null | undefined;
  createSummaryItems: Array<{ label: string; value: string }>;
  createChecklistItems: Array<{ label: string; done: boolean; optional?: boolean }>;
  createCanSubmit: boolean;
  ingredientImageState: {
    isGenerating: boolean;
    errorMessage: string | null;
  };
  trackingTransitionDraft?: TrackingTransitionDraftView | null;
  trackingTransitionBusy?: boolean;
  trackingTransitionError?: string | null;
  onCancelTrackingTransition?: () => void;
  onUpdatePresenceResolution?: (patch: Partial<PresenceTransitionResolution>) => void;
  onUpdateExactResolution?: (patch: Partial<ExactTransitionResolution>) => void;
  onConfirmTrackingTransition?: () => void;
  onUploadImage: (files: FileList | null) => void;
  onGenerateImage: (mode: 'reference' | 'text') => void;
  onResetImage: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSaveWithoutRestock: () => void;
  onBack: () => void;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  embedded?: boolean;
  renderIcon: (name: string) => ReactNode;
  renderStorageIcon: (storage: string) => ReactNode;
  ScrollableChipRail: (props: { ariaLabel: string; railClassName: string; children: ReactNode }) => ReactNode;
};

export function IngredientEditorView(props: IngredientEditorViewProps) {
  const editorContent = (
    <WorkspaceSubpageShell className="ingredients-workspace-subpage ingredients-create-workspace">
      {!props.embedded && (
        <header className="ingredients-create-header">
          <div className="ingredients-create-titleblock">
            <button className="workspace-back-link ingredient-detail-back" type="button" onClick={props.onBack}>
              ← {props.isEditingIngredient ? '返回食材详情' : props.activePanelBackLabel}
            </button>
            <p className="eyebrow">{props.isEditingIngredient ? '编辑食材' : '新增食材'}</p>
            <h2>{props.isEditingIngredient ? '编辑食材资料卡' : '新增食材资料卡'}</h2>
            <p className="subtle">
              {props.isEditingIngredient
                ? '调整名称、分类、图片和备注后，可以直接保存这张资料卡。'
                : '填写基础信息、图片和备注后，就能继续登记第一批库存。'}
            </p>
          </div>
          <Badge className="ingredients-create-page-badge">{props.isEditingIngredient ? '资料卡编辑' : '资料卡子页'}</Badge>
        </header>
      )}
      <form className="ingredients-create-layout" onSubmit={props.onSubmit}>
        <div className="ingredients-create-main">
          <section className="form-panel-section ingredients-create-section ingredients-create-basic-section">
            <div className="section-mini-title">基础信息</div>
            <div className="ingredients-create-form-stack">
              <div className="ingredients-create-form-left-col">
                <label className="ingredients-create-name-field">
                  <span>食材名称</span>
                  <input
                    className="text-input"
                    placeholder="请输入食材名称"
                    value={props.ingredientForm.name}
                    onChange={(event) => props.setIngredientForm({ ...props.ingredientForm, name: event.target.value })}
                  />
                </label>
                <div className="ingredients-quantity-tracking-card">
                  <div className="ingredients-restock-field-head">
                    <div>
                      <span>数量记录方式</span>
                      <p className="subtle">调料等常备品可只记录有无。</p>
                    </div>
                  </div>
                  <OptionChipGroup
                    ariaLabel="数量记录方式"
                    size="large"
                    className="ingredients-quantity-tracking-options"
                    options={[
                      { value: 'track_quantity', label: '记录数量' },
                      { value: 'not_track_quantity', label: '只记录有无' },
                    ]}
                    value={props.ingredientForm.quantityTrackingMode}
                    onChange={(value) =>
                      props.setIngredientForm({
                        ...props.ingredientForm,
                        quantityTrackingMode: value,
                        defaultLowStockThreshold:
                          value === 'not_track_quantity' ? '' : props.ingredientForm.defaultLowStockThreshold,
                      })
                    }
                  />
                </div>
              </div>
              <div className="ingredients-create-form-right-col">
                <div className="ingredients-category-field">
                  <span>分类</span>
                  <div className="ingredients-category-presets" aria-label="常见食材分类">
                    {props.ingredientVisibleCategoryPresets.map((item) => (
                      <button
                        key={item.label}
                        className={
                          !props.showIngredientCategoryCustomInput && props.ingredientForm.category === item.label
                            ? 'ingredients-category-chip active'
                            : 'ingredients-category-chip'
                        }
                        type="button"
                        onClick={() => {
                          props.setIngredientCustomCategoryOpen(false);
                          props.applyIngredientCategoryPreset(item.label);
                        }}
                      >
                        <span className="ingredients-category-chip-icon" aria-hidden="true">
                          <IngredientCategoryIcon name={item.icon} />
                        </span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                    <button
                      className={props.showIngredientCategoryCustomInput ? 'ingredients-category-chip active' : 'ingredients-category-chip'}
                      type="button"
                      onClick={() => {
                        props.setIngredientCustomCategoryOpen(true);
                        props.setIngredientForm({ ...props.ingredientForm, category: '' });
                      }}
                    >
                      <span className="ingredients-category-chip-icon" aria-hidden="true">
                        <IngredientCategoryIcon name="custom" />
                      </span>
                      <span>自定义</span>
                    </button>
                    {props.showIngredientCategoryCustomInput ? (
                      <input
                        className="ingredients-category-custom-input"
                        placeholder="自定义分类"
                        value={props.ingredientCategoryIsVisiblePreset ? '' : props.ingredientForm.category}
                        onChange={(event) => props.setIngredientForm({ ...props.ingredientForm, category: event.target.value })}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="form-grid compact-grid">
                <div className="ingredients-restock-field-group">
                  <div className="ingredients-restock-field-head">
                    <div>
                      <span>常用单位</span>
                      <p className="subtle">常见单位直接点选，特殊单位再补充输入。</p>
                    </div>
                    <button
                      className="ghost-button ingredients-modal-advanced-toggle ingredients-unit-conversion-inline-toggle"
                      type="button"
                      onClick={() => props.setIngredientUnitAdvancedOpen(!props.ingredientUnitAdvancedOpen)}
                    >
                      {props.ingredientUnitAdvancedOpen ? '收起换算' : '更多单位与换算'}
                    </button>
                  </div>
                  <OptionChipGroup
                    ariaLabel="默认单位"
                    value={props.ingredientUsesCustomUnit ? '__custom__' : props.ingredientForm.defaultUnit}
                    options={[
                      ...props.ingredientUnitOptions.map((unit) => ({ value: unit, label: unit })),
                      { value: '__custom__', label: '自定义' },
                    ]}
                    className="ingredients-unit-option-group"
                    onChange={(defaultUnit) =>
                      props.setIngredientForm({
                        ...props.ingredientForm,
                        defaultUnit: defaultUnit === '__custom__' ? '' : defaultUnit,
                      })
                    }
                  />
                  {props.ingredientUsesCustomUnit && (
                    <label className="ingredients-inline-custom-field">
                      <span>自定义单位</span>
                      <ComboboxField
                        ariaLabel="默认单位"
                        placeholder="选择或输入单位"
                        value={props.ingredientForm.defaultUnit}
                        options={props.ingredientUnitOptions.map((unit) => ({ value: unit, label: unit }))}
                        allowCustom
                        onChange={(defaultUnit) => props.setIngredientForm({ ...props.ingredientForm, defaultUnit: String(defaultUnit) })}
                      />
                    </label>
                  )}
                  <section className="ingredients-unit-conversion-panel">
                    {props.ingredientUnitAdvancedOpen && (
                      <div className="ingredients-unit-conversion-list">
                        {props.ingredientForm.unitConversions.length > 0 ? (
                          props.ingredientForm.unitConversions.map((entry) => (
                            <div key={entry.id} className="ingredients-unit-conversion-row">
                              <label>
                                <span>副单位</span>
                                <input
                                  className="text-input"
                                  placeholder="例如 袋"
                                  value={entry.unit}
                                  onChange={(event) =>
                                    props.setIngredientForm({
                                      ...props.ingredientForm,
                                      unitConversions: props.ingredientForm.unitConversions.map((item) =>
                                        item.id === entry.id ? { ...item, unit: event.target.value } : item
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                <span>换算值</span>
                                <input
                                  className="text-input"
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  placeholder="500"
                                  value={entry.ratioToDefault}
                                  onChange={(event) =>
                                    props.setIngredientForm({
                                      ...props.ingredientForm,
                                      unitConversions: props.ingredientForm.unitConversions.map((item) =>
                                        item.id === entry.id ? { ...item, ratioToDefault: event.target.value } : item
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <div className="ingredients-unit-conversion-preview">
                                <span>预览</span>
                                <strong>
                                  {normalizeIngredientUnit(entry.unit)
                                    ? `1 ${normalizeIngredientUnit(entry.unit)} = ${entry.ratioToDefault.trim() || '?'} ${props.trimmedIngredientUnit || '主单位'}`
                                    : `1 副单位 = ${entry.ratioToDefault.trim() || '?'} ${props.trimmedIngredientUnit || '主单位'}`}
                                </strong>
                              </div>
                              <ActionButton
                                tone="tertiary"
                                size="compact"
                                type="button"
                                className="ingredients-unit-conversion-remove"
                                onClick={() =>
                                  props.setIngredientForm({
                                    ...props.ingredientForm,
                                    unitConversions: props.ingredientForm.unitConversions.filter((item) => item.id !== entry.id),
                                  })
                                }
                              >
                                删除
                              </ActionButton>
                            </div>
                          ))
                        ) : (
                          <div className="ingredients-create-rule-note ingredients-unit-conversion-empty">
                            <span>先按主单位建档就够用</span>
                            <p>只有像“袋、盒、个”需要换成主单位时，再补充这里的高级设置。</p>
                          </div>
                        )}
                        <ActionButton
                          tone="secondary"
                          size="compact"
                          type="button"
                          className="ingredients-unit-conversion-add"
                          onClick={() =>
                            props.setIngredientForm({
                              ...props.ingredientForm,
                              unitConversions: [...props.ingredientForm.unitConversions, createIngredientUnitConversionDraft()],
                            })
                          }
                        >
                          添加副单位
                        </ActionButton>
                      </div>
                    )}
                  </section>
                </div>
                <div className="ingredients-restock-field-group ingredients-storage-field-group">
                  <div className="ingredients-restock-field-head">
                    <div>
                      <span>默认存放位置</span>
                      <p className="subtle">以后补库存时会先带出这里的建议位置。</p>
                    </div>
                  </div>
                  <OptionChipGroup
                    ariaLabel="默认保存位置"
                    value={props.ingredientUsesCustomStorage ? '__custom__' : props.ingredientForm.defaultStorage}
                    options={[
                      ...INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage })),
                      { value: '__custom__', label: '自定义' },
                    ]}
                    className="ingredients-storage-chip-group"
                    onChange={(defaultStorage) =>
                      props.setIngredientForm({
                        ...props.ingredientForm,
                        defaultStorage: defaultStorage === '__custom__' ? '' : defaultStorage,
                      })
                    }
                  />
                  {props.ingredientUsesCustomStorage && (
                    <label className="ingredients-storage-custom-field">
                      <span>自定义位置</span>
                      <input
                        className="text-input"
                        placeholder="例如 阴凉柜"
                        value={props.ingredientForm.defaultStorage}
                        onChange={(event) => props.setIngredientForm({ ...props.ingredientForm, defaultStorage: event.target.value })}
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="form-panel-section ingredients-create-section ingredients-create-rules-section">
            <div className="section-mini-title">补货默认值</div>
            <div className="form-grid compact-grid">
              <div className="ingredients-restock-field-group ingredients-create-expiry-rule-card">
                <div className="ingredients-restock-field-head">
                  <span>默认保质期规则</span>
                  <p className="subtle">把长期规则留在资料卡里，补库存时就不用每次重想。</p>
                </div>
                <OptionChipGroup
                  ariaLabel="默认保质期规则"
                  className="ingredients-rule-option-group"
                  options={[
                    { value: 'none', label: '不跟踪到期' },
                    { value: 'days', label: '买后几天' },
                    { value: 'manual_date', label: '包装到期日' },
                  ]}
                  value={props.ingredientForm.defaultExpiryMode}
                  onChange={(value) =>
                    props.setIngredientForm({
                      ...props.ingredientForm,
                      defaultExpiryMode: value,
                      defaultExpiryDays: value === 'days' ? String(props.ingredientDefaultExpiryRangeValue || 3) : '',
                    })
                  }
                />
              </div>
              <div className="ingredients-restock-field-group ingredients-create-lowstock-card">
                <div className="ingredients-restock-field-head">
                  <span>默认低库存提醒</span>
                  <p className="subtle">
                    {props.ingredientForm.quantityTrackingMode === 'not_track_quantity'
                      ? '只记录有无的食材不做数量阈值提醒。'
                      : '按食材总量提醒，值越小越接近“快没了”。'}
                  </p>
                </div>
                {props.ingredientForm.quantityTrackingMode === 'not_track_quantity' ? (
                  <div className="ingredients-create-rule-note ingredients-create-lowstock-note">
                    <span>提醒状态</span>
                    <p>当前只判断家里是否有这类食材，不因为数量不足触发补货提醒。</p>
                  </div>
                ) : (
                  <OptionChipGroup
                    ariaLabel="默认低库存提醒"
                    className="ingredients-rule-option-group"
                    options={[
                      { value: 'off', label: '不提醒' },
                      { value: 'on', label: '设置提醒' },
                    ]}
                    value={props.ingredientLowStockEnabled ? 'on' : 'off'}
                    onChange={(value) =>
                      props.setIngredientForm({
                        ...props.ingredientForm,
                        defaultLowStockThreshold: value === 'on' ? formatNumericString(props.ingredientLowStockValue) : '',
                      })
                    }
                  />
                )}
                {props.ingredientForm.quantityTrackingMode !== 'not_track_quantity' && props.ingredientLowStockEnabled ? (
                  <TouchStepperField
                    label="提醒阈值"
                    value={props.ingredientLowStockValue}
                    min={props.ingredientLowStockStep}
                    step={props.ingredientLowStockStep}
                    quickValues={props.ingredientLowStockQuickValues}
                    allowCustomInput
                    customInputLabel="自定义提醒值"
                    inputMin={props.ingredientLowStockStep}
                    inputStep={props.ingredientLowStockStep}
                    formatValue={(value) => `${formatNumericString(value)}${props.ingredientForm.defaultUnit || '个'}`}
                    helper="库存汇总少于这个值时，档案和提醒区会提示你补货。"
                    onChange={(value) =>
                      props.setIngredientForm({
                        ...props.ingredientForm,
                        defaultLowStockThreshold: formatNumericString(value),
                      })
                    }
                  />
                ) : props.ingredientForm.quantityTrackingMode !== 'not_track_quantity' ? (
                  <div className="ingredients-create-rule-note ingredients-create-lowstock-note">
                    <span>提醒状态</span>
                    <p>当前不做低库存提醒；需要时点一下就能开启，平时不用额外维护。</p>
                  </div>
                ) : null}
              </div>
              {props.ingredientForm.defaultExpiryMode === 'days' ? (
                <TouchRangeField
                  label="默认几天到期"
                  value={props.ingredientDefaultExpiryRangeValue}
                  min={1}
                  max={30}
                  step={1}
                  marks={EXPIRY_DAY_MARKS}
                  helper="以后补库存时会先带出这个天数。"
                  formatValue={(value) => `${value} 天`}
                  onChange={(value) => props.setIngredientForm({ ...props.ingredientForm, defaultExpiryDays: String(value) })}
                />
              ) : (
                <div className="ingredients-create-rule-note ingredients-create-expiry-note">
                  <span>到期录入方式</span>
                  <p>
                    {props.ingredientForm.defaultExpiryMode === 'manual_date'
                      ? '以后补库存时会直接让你填写包装上的具体日期。'
                      : '以后补库存默认不要求到期信息，也不会自动做临期提醒。'}
                  </p>
                </div>
              )}
              <div className="ingredients-create-rule-note ingredients-create-default-note">
                <span>补库存时自动带出</span>
                <p>这些默认值会在以后登记新批次时预填，你仍然可以按这次买回来的实际情况修改。</p>
              </div>
            </div>
          </section>

          <div className="ingredients-create-secondary">
            <div className="ingredients-create-media-section">
              <ImageComposer
                title="食材图片"
                value={props.ingredientForm.images}
                previewLabel={props.ingredientForm.name || '食材'}
                onUpload={props.onUploadImage}
                onGenerate={props.onGenerateImage}
                onReset={props.onResetImage}
                isGenerating={props.ingredientImageState.isGenerating}
                errorMessage={props.ingredientImageState.errorMessage}
                variant="workspace-inline"
              />
            </div>

            <section className="form-panel-section ingredients-create-section ingredients-create-notes-section">
              <div className="section-mini-title">备注</div>
              <div className="form-grid">
                <label className="span-two">
                  <span>补充说明</span>
                  <textarea
                    className="text-input"
                    placeholder="请输入补充说明（可选）"
                    rows={4}
                    value={props.ingredientForm.notes}
                    onChange={(event) => props.setIngredientForm({ ...props.ingredientForm, notes: event.target.value })}
                  />
                </label>
              </div>
            </section>
          </div>
        </div>

        <aside className="ingredients-create-side">
          <section className="form-panel-section ingredients-create-side-panel ingredients-create-action-rail">
            <div className="ingredients-create-rail-head">
              <div className="ingredients-create-rail-copy">
                <p className="eyebrow">录入摘要</p>
                <h3>{props.isEditingIngredient ? '准备保存这次修改' : '准备保存这张资料卡'}</h3>
                <p className="subtle">
                  {props.isEditingIngredient ? '保存后会回到详情页，也可以顺手继续登记新批次。' : '填完后直接保存，或继续进入首批库存登记。'}
                </p>
              </div>
            </div>

            <div className="ingredients-create-preview-card">
              {props.ingredientPreviewImage?.url ? (
                <MediaWithPlaceholder
                  src={resolveAssetUrl(props.ingredientPreviewImage.url)}
                  alt={props.ingredientForm.name || '食材图片'}
                />
              ) : (
                <div className="ingredients-create-preview-placeholder">
                  {props.renderIcon('image')}
                  <span>未配图</span>
                </div>
              )}
            </div>

            <div className="ingredients-create-summary-list">
              {props.createSummaryItems.map((item) => (
                <div key={item.label} className="ingredients-create-summary-row">
                  <span>{item.label}</span>
                  <strong title={item.value}>{item.value}</strong>
                </div>
              ))}
            </div>

            <div className="ingredients-create-progress">
              <p className="ingredients-create-progress-title">完成度</p>
              <div className="ingredients-create-progress-list">
                {props.createChecklistItems.map((item) => (
                  <div
                    key={item.label}
                    className={
                      item.done
                        ? 'ingredients-create-progress-item is-done'
                        : item.optional
                          ? 'ingredients-create-progress-item is-optional'
                          : 'ingredients-create-progress-item'
                    }
                  >
                    <span className="ingredients-create-progress-indicator" aria-hidden="true" />
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="ingredients-create-footer ingredients-create-footer-rail">
              <button className="solid-button" type="submit" disabled={!props.createCanSubmit}>
                {props.isCreatingIngredient || props.isUpdatingIngredient
                  ? '保存中...'
                  : props.isEditingIngredient
                      ? '保存修改并登记库存'
                      : '保存并登记库存'}
              </button>
              <button className="ghost-button" type="button" disabled={!props.createCanSubmit} onClick={props.onSaveWithoutRestock}>
                {props.isCreatingIngredient || props.isUpdatingIngredient
                  ? '保存中...'
                  : props.isEditingIngredient
                      ? '仅保存修改'
                      : '仅保存资料卡'}
              </button>
              <button className="ingredients-create-link-button" type="button" onClick={props.onBack}>
                {props.isEditingIngredient ? '返回详情' : '返回档案'}
              </button>
            </div>
          </section>
        </aside>
      </form>
    </WorkspaceSubpageShell>
  );

  const draft = props.trackingTransitionDraft ?? null;
  const transitionBusy = Boolean(props.trackingTransitionBusy);
  const toPresence = draft?.targetMode === 'not_track_quantity';
  const presence = draft?.presenceResolution;
  const exact = draft?.exactResolution;

  const trackingTransitionDialog = draft ? (
    <WorkspaceOverlayFrame
      rootClassName="ingredient-workspace-overlay-root ingredients-tracking-transition-root"
      closeOnBackdrop={!transitionBusy}
      onClose={() => {
        if (!transitionBusy) props.onCancelTrackingTransition?.();
      }}
    >
      <WorkspaceModal
        eyebrow="数量记录方式"
        title={toPresence ? '切换为只记录有无' : '切换为记录数量'}
        description={
          toPresence
            ? '切换后会按家庭级有无状态维护这道食材。历史精确批次会保留，但不再参与当前库存。'
            : '切换后会按精确库存批次维护这道食材。请明确确认当前没有库存，或登记真实初始数量。'
        }
        closeLabel="取消"
        className="ingredients-tracking-transition-modal"
        onClose={() => {
          if (!transitionBusy) props.onCancelTrackingTransition?.();
        }}
        footerActions={
          <FormActions
            primaryLabel={transitionBusy ? '切换中...' : '确认切换'}
            secondaryLabel="取消"
            isSubmitting={transitionBusy}
            onPrimary={() => props.onConfirmTrackingTransition?.()}
            onSecondary={() => props.onCancelTrackingTransition?.()}
          />
        }
      >
        <div className="ingredients-tracking-transition-body">
          {toPresence && presence ? (
            <>
              <div className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>当前家里情况</span>
                  <p className="subtle">只有你明确点选后，才会记为人工确认。</p>
                </div>
                <OptionChipGroup
                  ariaLabel="有无状态"
                  options={[
                    { value: 'present_unknown', label: '还在' },
                    { value: 'low', label: '少量' },
                    { value: 'sufficient', label: '充足' },
                    { value: 'absent', label: '没有了' },
                  ]}
                  value={presence.availability_level}
                  onChange={(value) =>
                    props.onUpdatePresenceResolution?.({
                      availability_level: value as InventoryAvailabilityLevel,
                      mark_inventory_confirmed: true,
                    })
                  }
                />
              </div>
              {presence.availability_level !== 'absent' ? (
                <div className="form-grid compact-grid">
                  <label>
                    <span>存放位置</span>
                    <input
                      className="text-input"
                      value={presence.storage_location || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdatePresenceResolution?.({
                          storage_location: event.target.value,
                          mark_inventory_confirmed: true,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>库存状态</span>
                    <select
                      className="text-input"
                      value={presence.inventory_status}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdatePresenceResolution?.({
                          inventory_status: event.target.value as InventoryStatus,
                          mark_inventory_confirmed: true,
                        })
                      }
                    >
                      <option value="fresh">新鲜</option>
                      <option value="opened">已开封</option>
                      <option value="frozen">冷冻</option>
                      <option value="expiring">临期</option>
                    </select>
                  </label>
                  <label>
                    <span>采购日</span>
                    <input
                      className="text-input"
                      type="date"
                      value={presence.purchase_date || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdatePresenceResolution?.({
                          purchase_date: event.target.value || null,
                          mark_inventory_confirmed: true,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>到期日</span>
                    <input
                      className="text-input"
                      type="date"
                      value={presence.expiry_date || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdatePresenceResolution?.({
                          expiry_date: event.target.value || null,
                          mark_inventory_confirmed: true,
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <div className="ingredients-create-rule-note">
                  <span>没有库存</span>
                  <p>确认后会清空家庭级位置和日期，并保留历史精确批次作为证据。</p>
                </div>
              )}
            </>
          ) : null}

          {!toPresence && exact ? (
            <>
              <div className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>初始库存处理</span>
                  <p className="subtle">不会把旧的占位数量 1 当成真实库存。</p>
                </div>
                <OptionChipGroup
                  ariaLabel="初始库存处理"
                  options={[
                    { value: 'absent', label: '当前没有' },
                    { value: 'stock', label: '登记真实库存' },
                  ]}
                  value={exact.confirm_absent ? 'absent' : 'stock'}
                  onChange={(value) =>
                    props.onUpdateExactResolution?.({
                      confirm_absent: value === 'absent',
                    })
                  }
                />
              </div>
              {!exact.confirm_absent ? (
                <div className="form-grid compact-grid">
                  <label>
                    <span>数量</span>
                    <input
                      className="text-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={exact.quantity ?? ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdateExactResolution?.({
                          quantity: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>单位</span>
                    <input
                      className="text-input"
                      value={exact.unit || ''}
                      disabled={transitionBusy}
                      onChange={(event) => props.onUpdateExactResolution?.({ unit: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>状态</span>
                    <select
                      className="text-input"
                      value={exact.inventory_status || 'fresh'}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdateExactResolution?.({
                          inventory_status: event.target.value as InventoryStatus,
                        })
                      }
                    >
                      <option value="fresh">新鲜</option>
                      <option value="opened">已开封</option>
                      <option value="frozen">冷冻</option>
                      <option value="expiring">临期</option>
                    </select>
                  </label>
                  <label>
                    <span>采购日</span>
                    <input
                      className="text-input"
                      type="date"
                      value={exact.purchase_date || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdateExactResolution?.({
                          purchase_date: event.target.value || null,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>存放位置</span>
                    <input
                      className="text-input"
                      value={exact.storage_location || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdateExactResolution?.({
                          storage_location: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>到期日</span>
                    <input
                      className="text-input"
                      type="date"
                      value={exact.expiry_date || ''}
                      disabled={transitionBusy}
                      onChange={(event) =>
                        props.onUpdateExactResolution?.({
                          expiry_date: event.target.value || null,
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <div className="ingredients-create-rule-note">
                  <span>明确没有库存</span>
                  <p>不会创建新的精确批次，原有无状态会清空并退出当前读取。</p>
                </div>
              )}
            </>
          ) : null}

          {props.trackingTransitionError ? (
            <p className="form-error" role="alert">
              {props.trackingTransitionError}
            </p>
          ) : null}
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  ) : null;

  const content = props.embedded
    ? <div className="ingredients-create-embedded">{editorContent}</div>
    : editorContent;

  return (
    <>
      {content}
      {trackingTransitionDialog}
    </>
  );
}
