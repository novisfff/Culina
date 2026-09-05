import { describe, expect, it } from 'vitest';
import { groupConversationsByDate } from './AiConversationHistory';
import { conversation } from './aiWorkspaceTestFixtures';

function todayAt(hour: number) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

describe('groupConversationsByDate', () => {
  it('sorts each date group by latest message time without mutating the input', () => {
    const older = conversation({ id: 'older', title: '旧消息', last_message_at: todayAt(1) });
    const newer = conversation({ id: 'newer', title: '新消息', last_message_at: todayAt(2) });
    const input = [older, newer];

    const groups = groupConversationsByDate(input);

    expect(groups[0]?.items.map((item) => item.id)).toEqual(['newer', 'older']);
    expect(input.map((item) => item.id)).toEqual(['older', 'newer']);
  });

  it('falls back to created time when last message time is missing or invalid', () => {
    const older = conversation({ id: 'older', last_message_at: null, created_at: todayAt(1) });
    const newer = conversation({ id: 'newer', last_message_at: 'not-a-date', created_at: todayAt(2) });

    expect(groupConversationsByDate([older, newer])[0]?.items.map((item) => item.id)).toEqual(['newer', 'older']);
  });
});
