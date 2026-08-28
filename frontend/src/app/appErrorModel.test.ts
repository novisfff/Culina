import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/request';
import { messageFromApiError, queryErrorMessage } from './appErrorModel';

describe('app error model', () => {
  it('prefers structured API messages', () => {
    expect(messageFromApiError(new ApiError({ status: 409, detail: '[object Object]', path: '/test', payload: { detail: { message: '冲突' } } }), '失败')).toBe('冲突');
    expect(queryErrorMessage(null, '失败')).toBeNull();
  });
});
