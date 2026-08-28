import type { InventoryStorageOverviewViewModel } from './workspaceModel';

type Props = {
  item: InventoryStorageOverviewViewModel;
  active: boolean;
  onSelect: () => void;
};

export function IngredientStorageIcon({ storage }: { storage: string }) {
  if (storage === '冷冻') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18" /><path d="m8 5 4 4 4-4" /><path d="m8 19 4-4 4 4" /><path d="M4.2 7.5 19.8 16.5" /><path d="m4.8 12.9 5.5-1.5-1.5-5.5" /><path d="m19.2 11.1-5.5 1.5 1.5 5.5" /><path d="M19.8 7.5 4.2 16.5" /><path d="m15.2 5.9-1.5 5.5 5.5 1.5" /><path d="m8.8 18.1 1.5-5.5-5.5-1.5" /></svg>;
  }
  if (storage === '常温') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="1.8" /><path d="M5 10h14" /><path d="M12 10v11" /><path d="M8.5 14v2" /><path d="M15.5 14v2" /><path d="M9 7.5h6" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M6 10h12" /><path d="M9 7h6" /><path d="M9 14v3" /><path d="M15 14v3" /></svg>;
}

function storageAsset(storage: string) {
  if (storage === '冷冻') return '/assets/asset_storage_freezer_frozen.webp';
  if (storage === '常温') return '/assets/asset_storage_pantry_roomtemp.webp';
  return '/assets/asset_storage_fridge_chilled.webp';
}

export function IngredientStorageOverviewCard({ item, active, onSelect }: Props) {
  const className = ['ingredients-inventory-overview-card', `tone-${item.tone}`, `storage-${item.key}`, active ? 'active' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={className} onClick={onSelect} aria-pressed={active}>
      <span className="ingredients-inventory-overview-illustration"><img src={storageAsset(item.key)} alt="" className="ingredients-inventory-storage-illustration" /></span>
      <div className="ingredients-inventory-overview-card-head">
        <span className="ingredients-inventory-overview-card-title"><span className="ingredients-inventory-overview-card-icon"><IngredientStorageIcon storage={item.key} /></span>{item.label}{active && <span className="ingredients-inventory-overview-card-focus">当前查看</span>}</span>
        <span className="ingredients-inventory-overview-card-action" aria-hidden="true">{active ? '✓' : '›'}</span>
      </div>
      <div className="ingredients-inventory-overview-card-body">
        <div className="ingredients-inventory-overview-card-metric"><strong>{item.ingredientCount}</strong><span>种食材</span></div>
        <div className="ingredients-inventory-overview-card-metric"><strong>{item.totalBatches}</strong><span>库存批次</span></div>
        <div className="ingredients-inventory-overview-card-metric"><strong>{item.alertCount}</strong><span>条提醒</span></div>
      </div>
      <p className="ingredients-inventory-overview-card-status"><span aria-hidden="true" />{item.statusLabel}</p>
    </button>
  );
}

export function IngredientStorageIllustration({ storage }: { storage: string }) {
  return <img src={storageAsset(storage)} alt="" className="ingredients-inventory-storage-illustration" />;
}
