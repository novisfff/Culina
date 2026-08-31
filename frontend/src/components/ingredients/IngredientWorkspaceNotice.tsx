import type { NoticeState } from '../../hooks/useNotice';
import { IngredientWorkspaceIcon } from './IngredientWorkspaceIcon';

export function IngredientWorkspaceNotice({ notice, onClose }: { notice: NoticeState | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="recipe-notice-icon">
        <IngredientWorkspaceIcon name={notice.tone === 'success' ? 'check' : 'exclamation'} />
      </span>
      <span className="recipe-notice-copy">
        <strong>{notice.title}</strong>
        <small>{notice.message}</small>
      </span>
      <button type="button" onClick={onClose} aria-label="关闭提示">×</button>
    </div>
  );
}
