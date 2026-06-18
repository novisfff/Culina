import { AI_WELCOME_SUGGESTIONS } from './AiWorkspaceOptions';

export function AiWelcomePrompt(props: { onPickSuggestion: (value: string) => void }) {
  return (
    <div className="ai-empty-prompt">
      <section className="ai-welcome-card">
        <div className="ai-welcome-visual" aria-hidden="true">
          <img src="/assets/bot_area.webp" alt="" className="ai-bot-visual-img" />
        </div>
        <div className="ai-welcome-copy">
          <strong>你好，我是你的 AI 厨房助手 👋</strong>
          <span>我可以帮你根据现有食材推荐菜谱、安排晚餐、分析临期食材、生成采购清单。</span>
        </div>
      </section>
      <div className="ai-welcome-grid" aria-label="快捷问题">
        {AI_WELCOME_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            className="ai-suggestion-grid-card"
            onClick={() => props.onPickSuggestion(suggestion.prompt)}
          >
            <strong>{suggestion.title}</strong>
            <span>{suggestion.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
