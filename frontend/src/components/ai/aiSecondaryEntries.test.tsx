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
});
