import { AiAutoExecutionSettingsView } from './AiAutoExecutionSettingsView';

export function AiAutoExecutionDesktopPanel(props: { familyId: string; isOwner: boolean; onBack: () => void }) {
  return <section className="ai-auto-execution-desktop-panel"><button type="button" className="ghost-button ai-auto-execution-back" onClick={props.onBack}>返回对话</button><AiAutoExecutionSettingsView familyId={props.familyId} isOwner={props.isOwner} /></section>;
}
