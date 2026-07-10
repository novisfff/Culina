import { describe, expect, it } from 'vitest';
import { chooseHumanInputOption } from './ai-skill-smoke-human-input.mjs';

describe('chooseHumanInputOption', () => {
  it('selects the affirmative shopping option without matching the negative option', () => {
    const selected = chooseHumanInputOption(
      ['仍加入 2 根 保留自动测试采购原因', '不加入 使用现有库存'],
      ['仍加入', '继续加入'],
    );

    expect(selected).toMatchObject({ index: 0, text: '仍加入 2 根 保留自动测试采购原因' });
  });

  it('tries the next hint when an earlier hint matches more than one option', () => {
    const selected = chooseHumanInputOption(
      ['加入购物清单', '不加入购物清单'],
      ['加入', '不加入'],
    );

    expect(selected.index).toBe(1);
  });

  it('rejects missing or ambiguous answer policies', () => {
    expect(() => chooseHumanInputOption(['继续', '继续并保存'], ['继续'])).toThrow('无法唯一匹配人工确认选项');
    expect(() => chooseHumanInputOption(['是', '否'], ['稍后'])).toThrow('无法唯一匹配人工确认选项');
  });
});

