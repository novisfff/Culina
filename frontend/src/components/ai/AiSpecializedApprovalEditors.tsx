import { asDraftArray, asNumber, asText } from './aiDraftValueUtils';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';

type DraftRecord = Record<string, unknown>;

function trackingModeLabel(value: unknown) {
  return asText(value) === 'not_track_quantity' ? '只记有无' : '精确数量';
}

function payloadRecord(draft: DraftRecord) {
  return draft.payload && typeof draft.payload === 'object' && !Array.isArray(draft.payload)
    ? draft.payload as DraftRecord
    : {};
}

export function validateIngredientTrackingTransitionForSubmit(draft: DraftRecord) {
  const payload = payloadRecord(draft);
  const targetMode = asText(payload.target_mode);
  if (targetMode === 'not_track_quantity') {
    const resolution = payload.presence_resolution && typeof payload.presence_resolution === 'object'
      ? payload.presence_resolution as DraftRecord
      : null;
    if (!resolution) return '切换到只记有无时需要确认当前库存状态';
    const availability = asText(resolution.availability_level);
    if (!['absent', 'present_unknown', 'low', 'sufficient'].includes(availability)) return '请选择切换后的库存状态';
    if (availability !== 'absent' && !asText(resolution.storage_location)) return '有库存时必须填写存放位置';
    return '';
  }
  if (targetMode === 'track_quantity') {
    const resolution = payload.exact_resolution && typeof payload.exact_resolution === 'object'
      ? payload.exact_resolution as DraftRecord
      : null;
    if (!resolution) return '切换到精确数量时需要确认当前实际数量';
    if (resolution.confirm_absent === true) return '';
    if (asNumber(resolution.quantity, 0) <= 0) return '当前实际数量必须大于 0，或者选择“当前没有库存”';
    if (!asText(resolution.unit)) return '当前实际数量单位不能为空';
    if (!asText(resolution.inventory_status)) return '请选择当前库存状态';
    if (!asText(resolution.purchase_date)) return '请选择当前库存采购日';
    if (!asText(resolution.storage_location)) return '当前库存存放位置不能为空';
    return '';
  }
  return '数量追踪目标方式不正确';
}

export function AiIngredientTrackingTransitionApproval({
  draft,
  readonly,
  onChange,
}: {
  draft: DraftRecord;
  readonly: boolean;
  onChange: (draft: DraftRecord) => void;
}) {
  const payload = payloadRecord(draft);
  const before = draft.before && typeof draft.before === 'object' && !Array.isArray(draft.before)
    ? draft.before as DraftRecord
    : {};
  const targetMode = asText(payload.target_mode);
  const batchCount = asDraftArray(payload.observed_batches).length;
  const updatePayload = (patch: DraftRecord) => onChange({ ...draft, payload: { ...payload, ...patch } });
  const presence = payload.presence_resolution && typeof payload.presence_resolution === 'object'
    ? payload.presence_resolution as DraftRecord
    : {};
  const exact = payload.exact_resolution && typeof payload.exact_resolution === 'object'
    ? payload.exact_resolution as DraftRecord
    : {};
  const updatePresence = (patch: DraftRecord) => updatePayload({ presence_resolution: { ...presence, ...patch } });
  const updateExact = (patch: DraftRecord) => updatePayload({ exact_resolution: { ...exact, ...patch } });
  const absent = exact.confirm_absent === true;

  return (
    <section className="ai-ingredient-tracking-transition" aria-label="数量追踪方式切换">
      <header>
        <div>
          <span>{asText(before.name, '当前食材')}</span>
          <strong>{trackingModeLabel(before.quantity_tracking_mode)} → {trackingModeLabel(targetMode)}</strong>
        </div>
        <em>{targetMode === 'not_track_quantity' ? `${batchCount} 个现有批次将按选择折叠` : '需要填写当前真实数量'}</em>
      </header>
      <AiDraftImpactNote tone="danger" title="数量追踪方式切换影响" className="ai-ingredient-tracking-impact">
        <p>确认后会改变这个食材的数量追踪方式。</p>
        <p>
          {targetMode === 'not_track_quantity'
            ? `${batchCount} 个现有批次将按选择折叠，精确数量不会继续保留。`
            : '需要依据当前真实库存重新建立精确数量状态。'}
        </p>
      </AiDraftImpactNote>

      {targetMode === 'not_track_quantity' ? (
        <div className="ai-specialized-form-grid">
          <label className="ai-resource-field">
            <span>折叠后的库存状态</span>
            <select className="text-input" value={asText(presence.availability_level, 'sufficient')} disabled={readonly} onChange={(event) => {
              const availability = event.target.value;
              updatePresence({
                availability_level: availability,
                ...(availability === 'absent' ? { purchase_date: null, expiry_date: null, storage_location: null } : {}),
              });
            }}>
              <option value="sufficient">充足</option>
              <option value="present_unknown">还在，数量不确定</option>
              <option value="low">少量</option>
              <option value="absent">当前没有</option>
            </select>
          </label>
          {asText(presence.availability_level, 'sufficient') !== 'absent' ? (
            <>
              <label className="ai-resource-field">
                <span>库存状态</span>
                <select className="text-input" value={asText(presence.inventory_status, 'fresh')} disabled={readonly} onChange={(event) => updatePresence({ inventory_status: event.target.value })}>
                  <option value="fresh">新鲜</option><option value="opened">已开封</option><option value="frozen">冷冻</option><option value="expiring">临期</option>
                </select>
              </label>
              <label className="ai-resource-field"><span>存放位置</span><input className="text-input" value={asText(presence.storage_location)} disabled={readonly} onChange={(event) => updatePresence({ storage_location: event.target.value })} /></label>
              <label className="ai-resource-field"><span>采购日</span><input className="text-input" type="date" value={asText(presence.purchase_date)} disabled={readonly} onChange={(event) => updatePresence({ purchase_date: event.target.value || null })} /></label>
              <label className="ai-resource-field"><span>到期日</span><input className="text-input" type="date" value={asText(presence.expiry_date)} disabled={readonly} onChange={(event) => updatePresence({ expiry_date: event.target.value || null })} /></label>
            </>
          ) : null}
          <label className="ai-resource-field ai-specialized-full"><span>备注</span><textarea className="text-input" rows={2} value={asText(presence.notes)} disabled={readonly} onChange={(event) => updatePresence({ notes: event.target.value })} /></label>
        </div>
      ) : (
        <div className="ai-specialized-form-grid">
          <label className="ai-specialized-checkbox ai-specialized-full"><input type="checkbox" checked={absent} disabled={readonly} onChange={(event) => updatePayload({ exact_resolution: event.target.checked ? { confirm_absent: true, quantity: null, unit: null, inventory_status: null, purchase_date: null, expiry_date: null, storage_location: null, notes: '' } : { ...exact, confirm_absent: false } })} /><span>当前没有库存</span></label>
          {!absent ? (
            <>
              <label className="ai-resource-field"><span>当前实际数量</span><input className="text-input" type="number" min="0" step="any" value={exact.quantity == null ? '' : String(exact.quantity)} disabled={readonly} onChange={(event) => updateExact({ quantity: event.target.value ? Number(event.target.value) : null })} /></label>
              <label className="ai-resource-field"><span>单位</span><input className="text-input" value={asText(exact.unit)} disabled={readonly} onChange={(event) => updateExact({ unit: event.target.value })} /></label>
              <label className="ai-resource-field"><span>库存状态</span><select className="text-input" value={asText(exact.inventory_status, 'fresh')} disabled={readonly} onChange={(event) => updateExact({ inventory_status: event.target.value })}><option value="fresh">新鲜</option><option value="opened">已开封</option><option value="frozen">冷冻</option><option value="expiring">临期</option></select></label>
              <label className="ai-resource-field"><span>存放位置</span><input className="text-input" value={asText(exact.storage_location)} disabled={readonly} onChange={(event) => updateExact({ storage_location: event.target.value })} /></label>
              <label className="ai-resource-field"><span>采购日</span><input className="text-input" type="date" value={asText(exact.purchase_date)} disabled={readonly} onChange={(event) => updateExact({ purchase_date: event.target.value || null })} /></label>
              <label className="ai-resource-field"><span>到期日</span><input className="text-input" type="date" value={asText(exact.expiry_date)} disabled={readonly} onChange={(event) => updateExact({ expiry_date: event.target.value || null })} /></label>
              <label className="ai-resource-field ai-specialized-full"><span>备注</span><textarea className="text-input" rows={2} value={asText(exact.notes)} disabled={readonly} onChange={(event) => updateExact({ notes: event.target.value })} /></label>
            </>
          ) : null}
        </div>
      )}
      <p className="ai-specialized-boundary-copy">目标方式和版本边界由系统锁定；确认时会再次校验食材、库存状态和批次版本。</p>
    </section>
  );
}

function mealFoods(value: unknown): DraftRecord[] {
  return asDraftArray(value).map((item): DraftRecord => ({
    ...item,
    foodId: asText(item.foodId) || asText(item.food_id),
    name: asText(item.name) || asText(item.foodName),
  }));
}

export function validateMealCompositionCorrectionForSubmit(draft: DraftRecord) {
  const payload = payloadRecord(draft);
  if (asText(payload.inventoryAdjustment) !== 'none') return '纠正餐食组成不能调整历史库存';
  const foods = mealFoods(payload.foods);
  if (foods.length === 0) return '餐食记录至少需要保留 1 个食物';
  if (foods.some((food) => !asText(food.foodId) || !asText(food.name))) return '餐食组成中的食物必须来自食物库';
  if (foods.some((food) => asNumber(food.servings, 0) <= 0)) return '每个食物的份数必须大于 0';
  return '';
}

export function AiMealCompositionCorrectionApproval({ draft, readonly, onChange }: { draft: DraftRecord; readonly: boolean; onChange: (draft: DraftRecord) => void }) {
  const payload = payloadRecord(draft);
  const before = draft.before && typeof draft.before === 'object' && !Array.isArray(draft.before) ? draft.before as DraftRecord : {};
  const beforeFoods = mealFoods(before.foods);
  const foods = mealFoods(payload.foods);
  const updateFoods = (nextFoods: DraftRecord[]) => onChange({ ...draft, payload: { ...payload, foods: nextFoods, inventoryAdjustment: 'none' } });
  return (
    <section className="ai-meal-composition-correction" aria-label="纠正餐食组成">
      <div className="ai-meal-composition-compare">
        <section><span>原记录</span>{beforeFoods.map((food) => <p key={asText(food.entryId) || asText(food.foodId)}><strong>{asText(food.name)}</strong><em>{asNumber(food.servings, 1)} 份</em></p>)}</section>
        <span aria-hidden="true">→</span>
        <section><span>纠正后</span>{foods.map((food) => <p key={asText(food.entryId) || asText(food.foodId)}><strong>{asText(food.name)}</strong><em>{asNumber(food.servings, 1)} 份</em></p>)}</section>
      </div>
      <div className="ai-meal-composition-edit-list">
        {foods.map((food, index) => (
          <article key={asText(food.entryId) || `${asText(food.foodId)}-${index}`}>
            <header><strong>{asText(food.name, '未命名食物')}</strong>{!readonly && foods.length > 1 ? <button type="button" className="ghost-button" onClick={() => updateFoods(foods.filter((_, itemIndex) => itemIndex !== index))}>移除</button> : null}</header>
            <div className="ai-specialized-form-grid">
              <label className="ai-resource-field"><span>实际份数</span><input className="text-input" type="number" min="0.1" step="0.1" value={String(food.servings ?? 1)} disabled={readonly} onChange={(event) => updateFoods(foods.map((item, itemIndex) => itemIndex === index ? { ...item, servings: Number(event.target.value) } : item))} /></label>
              <label className="ai-resource-field"><span>食物备注</span><input className="text-input" value={asText(food.note)} disabled={readonly} onChange={(event) => updateFoods(foods.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item))} /></label>
            </div>
          </article>
        ))}
      </div>
      <p className="ai-meal-composition-inventory-boundary">不会补回、追加或重新计算历史库存，也不会改变关联餐食计划事实。</p>
    </section>
  );
}
