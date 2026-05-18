import { describe, expect, it } from 'vitest';
import { runAiConversation } from './mockAi';
import { createInitialState } from './seed';

describe('runAiConversation', () => {
  it('creates recommendation based on family context', () => {
    const state = createInitialState();
    const result = runAiConversation(state, 'recommendation', '今晚做什么', state.currentUserId, {});

    expect(result.conversation.response).toContain('推荐');
    expect(result.recommendation?.detail).toContain('匹配库存度');
  });

  it('answers food question using recipe context', () => {
    const state = createInitialState();
    const selfMadeFood = state.foods.find((food) => food.type === 'selfMade');
    if (!selfMadeFood) {
      throw new Error('Missing seeded self-made food');
    }

    const result = runAiConversation(
      state,
      'foodQa',
      '这道菜怎么做得更清淡？',
      state.currentUserId,
      { foodId: selfMadeFood.id }
    );

    expect(result.conversation.response).toContain('更清淡');
    expect(result.conversation.response).toContain(selfMadeFood.name);
  });
});
