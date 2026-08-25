import { AiAutoExecutionSettingsView } from './AiAutoExecutionSettingsView';

export function AiAutoExecutionMobilePage(props: { familyId: string; isOwner: boolean; onBack: () => void }) {
  return <main className="ai-auto-execution-mobile-page"><header><button type="button" className="ai-auto-execution-back" onClick={props.onBack}>返回</button><h1>AI 自动执行</h1></header><AiAutoExecutionSettingsView familyId={props.familyId} isOwner={props.isOwner} /></main>;
}
