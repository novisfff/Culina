import { FormActions, WorkspaceModal } from '../ui-kit';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import {
  getRecipeDraftGenerationStepState,
  type RecipeDraftAiFormState,
  type RecipeDraftGenerationStage,
} from './RecipeWorkspaceModel';

type RecipeDraftDialogProps = {
  aiSourceSummary: Array<{ label: string; value: string }>;
  form: RecipeDraftAiFormState;
  stage: RecipeDraftGenerationStage;
  statusCopy: { title: string; description: string };
  statusSteps: string[];
  error: string | null;
  actionLabel: string;
  isBusy: boolean;
  isImageGenerating: boolean;
  onChangeForm: (form: RecipeDraftAiFormState) => void;
  onGenerate: () => void;
  onClose: () => void;
};

export function RecipeDraftDialog(props: RecipeDraftDialogProps) {
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title="AI 补全菜谱"
        description="AI 会基于当前编辑表单里的信息生成完整菜谱，确认后覆盖左侧表单内容。"
        eyebrow="AI 生成"
        onClose={props.onClose}
        className="recipe-ai-draft-modal"
      >
        <div className="recipe-ai-draft-modal-body">
          <section className="recipe-ai-source-panel">
            <h3>将基于这些信息生成</h3>
            <div className="recipe-ai-source-grid">
              {props.aiSourceSummary.map((item) => (
                <div key={item.label}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>

          {props.stage !== 'idle' && (
            <section className={`recipe-ai-generation-status stage-${props.stage}`} aria-live="polite">
              <div className="recipe-ai-generation-status-head">
                {props.isBusy ? <span className="recipe-ai-generation-spinner" aria-hidden="true" /> : <RecipeUiIcon name={props.stage === 'error' ? 'warning' : 'check'} />}
                <div>
                  <strong>{props.statusCopy.title}</strong>
                  <small>{props.statusCopy.description}</small>
                </div>
              </div>
              <div className="recipe-ai-generation-steps">
                {props.statusSteps.map((step, index) => {
                  const stepState = getRecipeDraftGenerationStepState(props.stage, index);
                  return (
                    <span key={step} className={`recipe-ai-generation-step ${stepState}`}>
                      <i>{stepState === 'completed' ? '✓' : index + 1}</i>
                      {step}
                    </span>
                  );
                })}
              </div>
            </section>
          )}

          <label className="recipe-ai-prompt-field">
            <span>补充说明</span>
            <textarea
              className="text-input"
              rows={5}
              value={props.form.prompt}
              placeholder="例如：清淡少油，适合孩子，尽量 20 分钟内完成；步骤写得详细一点。"
              onChange={(event) => props.onChangeForm({ prompt: event.target.value })}
              disabled={props.isBusy}
            />
          </label>

          {props.error ? <p className="form-error">{props.error}</p> : null}

          <FormActions
            className="recipe-ai-draft-modal-actions"
            primaryLabel={props.actionLabel}
            primaryDisabled={props.isBusy || props.isImageGenerating || props.stage === 'done'}
            isSubmitting={props.isBusy}
            secondaryLabel="取消"
            onPrimary={props.onGenerate}
            onSecondary={props.onClose}
          />
        </div>
      </WorkspaceModal>
    </div>
  );
}
