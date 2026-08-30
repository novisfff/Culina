import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAiApproval, loadAiDebug, loadAiHumanInput, loadAiMarkdown } from './entries';

describe('AI secondary entries', () => {
  it('loads heavy views through explicit entry points', async () => {
    const [markdown, approval, humanInput, debug] = await Promise.all([
      loadAiMarkdown(),
      loadAiApproval(),
      loadAiHumanInput(),
      loadAiDebug(),
    ]);
    expect(markdown.default).toBeTypeOf('function');
    expect(approval.default).toBeTypeOf('function');
    expect(humanInput.default).toBeTypeOf('function');
    expect(debug.default).toBeTypeOf('function');
  });

  it('keeps human-input entry independent from the conversation route', () => {
    const source = readFileSync(resolve(__dirname, 'entries/AiHumanInputEntry.tsx'), 'utf8');
    expect(source).not.toContain("../AiConversationThread");
    expect(source).toContain("../AiHumanInputRequestPanel");
  });
});
