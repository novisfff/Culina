import type { FormEvent } from 'react';
import type { InventoryOverviewItem } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { formatDate } from '../../lib/ui';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import type {
  FoodStockAdjustDialogState,
  FoodStockDeductDialogState,
  FoodStockInventoryFollowUpState,
} from './useIngredientFoodStockState';

const QUANTITY_PRESETS = ['1', '2', '5', '10'];
const EXPIRY_PRESETS = [{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }];
const SOURCE_PRESETS = ['超市', '便利店', '网购', '盒马'];

type IngredientFoodStockDialogsProps = {
  todayDate: string;
  inventoryFollowUp: FoodStockInventoryFollowUpState | null;
  foodStockDeductDialog: FoodStockDeductDialogState | null;
  foodStockAdjustDialog: FoodStockAdjustDialogState | null;
  foodStockSubmitting: 'meal' | 'adjust' | null;
  setInventoryFollowUp: (value: FoodStockInventoryFollowUpState | null) => void;
  setFoodStockDeductDialog: (value: FoodStockDeductDialogState | null) => void;
  setFoodStockAdjustDialog: (value: FoodStockAdjustDialogState | null) => void;
  setFoodStockRestockQuantity: (value: string) => void;
  setFoodStockRestockExpiryDays: (value: number | null) => void;
  setFoodStockRestockSource: (value: string) => void;
  submitInventoryFollowUp: (event: FormEvent<HTMLFormElement>) => void;
  submitFoodStockDeductDialog: (event: FormEvent<HTMLFormElement>) => void;
  submitFoodStockAdjustDialog: (event: FormEvent<HTMLFormElement>) => void;
};

function ItemHero({ item, label, className = '' }: { item: InventoryOverviewItem; label: string; className?: string }) {
  return (
    <div className={`ingredients-food-stock-quick-hero ${className}`.trim()}>
      <span className="ingredients-food-stock-quick-cover">
        <MediaWithPlaceholder src={resolveMediaUrl(item.image, 'card')} srcSet={buildMediaSrcSet(item.image)} sizes={buildMediaSizes('thumb')} alt="" emptyLabel="成品图片" showLabel={false} />
      </span>
      <span className="ingredients-food-stock-quick-copy">
        <strong>{item.title}</strong>
        <small>{[item.category || '成品', item.storage_location || '常温', `${label} ${item.quantity_label}`].join(' · ')}</small>
      </span>
    </div>
  );
}

function QuantityInput({ value, unit, disabled, onChange }: { value: string; unit: string; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="ingredients-food-stock-inline-input"><input className="text-input" type="number" min="0.1" step="0.1" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><em>{unit || '份'}</em></div>;
}

export function IngredientFoodStockDialogs(props: IngredientFoodStockDialogsProps) {
  const mealBusy = props.foodStockSubmitting === 'meal';
  const adjustBusy = props.foodStockSubmitting === 'adjust';
  return <>
    {props.inventoryFollowUp && <WorkspaceOverlayFrame rootClassName="ingredient-workspace-overlay-root ingredients-food-stock-overlay-root" closeOnBackdrop={!mealBusy} onClose={() => { if (!mealBusy) props.setInventoryFollowUp(null); }}>
      <WorkspaceModal eyebrow="成品库存" title="更新库存" description="餐已记下。可选继续扣减库存；取消不影响刚才的记录。" className="ingredients-food-stock-modal ingredients-food-stock-quick-modal" closeLabel="关闭" onClose={() => { if (!mealBusy) props.setInventoryFollowUp(null); }} footerActions={<FormActions primaryLabel="确认扣减" primaryType="submit" primaryForm="ingredients-food-stock-inventory-followup-form" isSubmitting={mealBusy} secondaryLabel="跳过" onSecondary={() => props.setInventoryFollowUp(null)} />}>
        <form id="ingredients-food-stock-inventory-followup-form" className="ingredients-food-stock-form ingredients-food-stock-quick-form" onSubmit={props.submitInventoryFollowUp}>
          <ItemHero item={props.inventoryFollowUp.item} label="库存" />
          <label className="ingredients-food-stock-field"><span>扣减数量</span><QuantityInput value={props.inventoryFollowUp.stockQuantity} unit={props.inventoryFollowUp.item.unit || '份'} disabled={mealBusy} onChange={(value) => props.setInventoryFollowUp({ ...props.inventoryFollowUp!, stockQuantity: value, error: null })} /></label>
          {props.inventoryFollowUp.error && <p className="form-error ingredients-food-stock-error" role="alert">{props.inventoryFollowUp.error}</p>}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>}
    {props.foodStockDeductDialog && <WorkspaceOverlayFrame rootClassName="ingredient-workspace-overlay-root ingredients-food-stock-overlay-root" closeOnBackdrop={!mealBusy} onClose={() => { if (!mealBusy) props.setFoodStockDeductDialog(null); }}>
      <WorkspaceModal eyebrow="成品库存" title="扣减库存" description="只扣库存，不保存餐食记录。" className="ingredients-food-stock-modal ingredients-food-stock-quick-modal" closeLabel="关闭" onClose={() => { if (!mealBusy) props.setFoodStockDeductDialog(null); }} footerActions={<FormActions primaryLabel="确认扣减" primaryType="submit" primaryForm="ingredients-food-stock-deduct-form" isSubmitting={mealBusy} secondaryLabel="取消" onSecondary={() => props.setFoodStockDeductDialog(null)} />}>
        <form id="ingredients-food-stock-deduct-form" className="ingredients-food-stock-form ingredients-food-stock-quick-form" onSubmit={props.submitFoodStockDeductDialog}>
          <ItemHero item={props.foodStockDeductDialog.item} label="库存" />
          <div className="ingredients-food-stock-no-record-note"><strong>不保存餐食记录</strong><span>这次只从成品库存里扣掉数量，适合清点、丢失或已经记录过的情况。</span></div>
          <label className="ingredients-food-stock-field"><span>扣减数量</span><QuantityInput value={props.foodStockDeductDialog.stockQuantity} unit={props.foodStockDeductDialog.item.unit || '份'} disabled={mealBusy} onChange={(value) => props.setFoodStockDeductDialog({ ...props.foodStockDeductDialog!, stockQuantity: value, error: null })} /></label>
          {props.foodStockDeductDialog.error && <p className="form-error ingredients-food-stock-error" role="alert">{props.foodStockDeductDialog.error}</p>}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>}
    {props.foodStockAdjustDialog && <WorkspaceOverlayFrame rootClassName="ingredient-workspace-overlay-root ingredients-food-stock-overlay-root" closeOnBackdrop={!adjustBusy} onClose={() => { if (!adjustBusy) props.setFoodStockAdjustDialog(null); }}>
      <WorkspaceModal eyebrow="成品库存" title="补充库存" description="补充数量和到期信息；存放位置统一在食物信息中设置。" className="ingredients-food-stock-modal ingredients-food-stock-restock-modal" closeLabel="关闭" onClose={() => { if (!adjustBusy) props.setFoodStockAdjustDialog(null); }} footerActions={<FormActions primaryLabel="确认补充" primaryType="submit" primaryForm="ingredients-food-stock-adjust-form" isSubmitting={adjustBusy} secondaryLabel="取消" onSecondary={() => props.setFoodStockAdjustDialog(null)} />}>
        <form id="ingredients-food-stock-adjust-form" className="ingredients-food-stock-form ingredients-food-stock-restock-form" onSubmit={props.submitFoodStockAdjustDialog}>
          <ItemHero item={props.foodStockAdjustDialog.item} label="当前" className="ingredients-food-stock-restock-hero" />
          <div className="ingredients-food-stock-summary ingredients-food-stock-restock-summary"><strong>补充后更新成品库存</strong><span>存放位置：{props.foodStockAdjustDialog.item.storage_location || '常温'}，如需调整请到食物信息修改。</span></div>
          <section className="ingredients-food-stock-restock-section"><div className="ingredients-food-stock-restock-section-head"><strong>补充数量</strong><span>常用数量点一下就填好</span></div><div className="ingredients-food-stock-restock-unit-row"><label className="ingredients-food-stock-field"><span>数量</span><input className="text-input" type="number" min="0.1" step="0.1" value={props.foodStockAdjustDialog.quantity} disabled={adjustBusy} onChange={(event) => props.setFoodStockAdjustDialog({ ...props.foodStockAdjustDialog!, quantity: event.target.value, error: null })} /></label><label className="ingredients-food-stock-field"><span>单位</span><input className="text-input" value={props.foodStockAdjustDialog.unit} disabled={adjustBusy} onChange={(event) => props.setFoodStockAdjustDialog({ ...props.foodStockAdjustDialog!, unit: event.target.value, error: null })} /></label></div><div className="ingredients-food-stock-restock-presets ingredients-food-stock-quantity-presets" aria-label="常用补充数量">{QUANTITY_PRESETS.map((quantity) => <button key={quantity} type="button" className={props.foodStockAdjustDialog!.quantity === quantity ? 'active' : ''} disabled={adjustBusy} onClick={() => props.setFoodStockRestockQuantity(quantity)}>+{quantity}<span>{props.foodStockAdjustDialog!.unit || props.foodStockAdjustDialog!.item.unit || '份'}</span></button>)}</div></section>
          <section className="ingredients-food-stock-restock-section"><div className="ingredients-food-stock-restock-section-head"><strong>到期信息</strong><span>不确定可以先不填</span></div><label className="ingredients-food-stock-field"><span>到期日</span><input className="text-input" type="date" value={props.foodStockAdjustDialog.expiryDate} disabled={adjustBusy} onChange={(event) => props.setFoodStockAdjustDialog({ ...props.foodStockAdjustDialog!, expiryDate: event.target.value, error: null })} /></label><div className="ingredients-food-stock-restock-presets ingredients-food-stock-expiry-presets" aria-label="常用到期时间"><button type="button" className={props.foodStockAdjustDialog.expiryDate ? '' : 'active'} disabled={adjustBusy} onClick={() => props.setFoodStockRestockExpiryDays(null)}>不设置到期日</button>{EXPIRY_PRESETS.map((preset) => { const presetDate = addDateKeyDays(props.todayDate, preset.value); return <button key={preset.value} type="button" className={props.foodStockAdjustDialog!.expiryDate === presetDate ? 'active' : ''} disabled={adjustBusy} onClick={() => props.setFoodStockRestockExpiryDays(preset.value)}>{preset.label}<span>{formatDate(presetDate)}</span></button>; })}</div><p className="ingredients-food-stock-restock-helper">包装没有明确日期时可以留空，之后可在食物信息中修改，或下次补充库存时再填写。</p></section>
          <section className="ingredients-food-stock-restock-section"><div className="ingredients-food-stock-restock-section-head"><strong>购买来源</strong><span>方便下次再选和回看</span></div><label className="ingredients-food-stock-field"><span>购买来源</span><input className="text-input" placeholder="例如：楼下超市、京东、盒马" value={props.foodStockAdjustDialog.purchaseSource} disabled={adjustBusy} onChange={(event) => props.setFoodStockAdjustDialog({ ...props.foodStockAdjustDialog!, purchaseSource: event.target.value, error: null })} /></label><div className="ingredients-food-stock-restock-presets ingredients-food-stock-source-presets" aria-label="常用购买来源">{SOURCE_PRESETS.map((source) => <button key={source} type="button" className={props.foodStockAdjustDialog!.purchaseSource === source ? 'active' : ''} disabled={adjustBusy} onClick={() => props.setFoodStockRestockSource(source)}>{source}</button>)}</div></section>
          {props.foodStockAdjustDialog.error && <p className="form-error ingredients-food-stock-error" role="alert">{props.foodStockAdjustDialog.error}</p>}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>}
  </>;
}
