import { describe, expect, it } from 'vitest';
import { AI_WELCOME_SUGGESTIONS } from './aiWelcomeSuggestions';

describe('AI welcome suggestions', () => {
  it('covers the remediation plan capability shortcuts with a shared config', () => {
    expect(AI_WELCOME_SUGGESTIONS).toHaveLength(7);
    expect(AI_WELCOME_SUGGESTIONS.map((item) => item.title)).toEqual([
      '🥬 新增食材',
      '📦 记录购买的食材',
      '🗓️ 修改计划',
      '🛒 完成待买内容',
      '🍲 修改菜谱',
      '🍽️ 记录餐食',
      '🔥 开始烹饪',
    ]);
    expect(new Set(AI_WELCOME_SUGGESTIONS.map((item) => item.prompt)).size).toBe(AI_WELCOME_SUGGESTIONS.length);
  });
});
