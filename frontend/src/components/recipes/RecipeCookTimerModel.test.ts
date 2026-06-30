import { describe, expect, it } from 'vitest';
import type { RecipeStep } from '../../api/types';
import {
  advanceCookTimers,
  getNextManualTimerName,
  removeCookTimer,
  transitionCookTimerForStep,
  type CookTimerState,
} from './RecipeWorkspaceModel';

function timer(overrides: Partial<CookTimerState> = {}): CookTimerState {
  return {
    id: 'timer-1',
    name: '自定义 1',
    seconds: 0,
    running: false,
    lastTickedAt: null,
    mode: 'countup',
    durationSeconds: null,
    source: 'manual',
    stepId: null,
    ...overrides,
  };
}

function step(id: string, title: string, estimatedMinutes: number | null): RecipeStep {
  return {
    id,
    title,
    text: title,
    icon: 'pan',
    summary: '',
    estimated_minutes: estimatedMinutes,
    tip: '',
    key_points: [],
  };
}

function transition(timers: CookTimerState[], activeTimerId: string, nextStep: RecipeStep, nextStepIndex = 1) {
  return transitionCookTimerForStep({
    timers,
    activeTimerId,
    currentStepIndex: 0,
    nextStepIndex,
    nextStep,
    newTimerId: 'new-step-timer',
  });
}

describe('cook timer step transitions', () => {
  it('overwrites the active unused manual timer with the next step recommendation', () => {
    const result = transition([timer()], 'timer-1', step('step-2', '焖煮', 8));

    expect(result.activeTimerId).toBe('timer-1');
    expect(result.timers).toEqual([
      timer({
        name: '焖煮',
        mode: 'countdown',
        durationSeconds: 480,
        source: 'step',
        stepId: 'step-2',
      }),
    ]);
  });

  it.each([
    ['running', timer({ running: true })],
    ['paused with progress', timer({ seconds: 12 })],
    ['finished', timer({ seconds: 60, mode: 'countdown', durationSeconds: 60 })],
  ])('preserves a %s timer and creates a new step timer', (_, activeTimer) => {
    const result = transition([activeTimer], activeTimer.id, step('step-2', '焖煮', 8));

    expect(result.activeTimerId).toBe('new-step-timer');
    expect(result.timers[0]).toEqual(activeTimer);
    expect(result.timers[1]).toEqual(timer({
      id: 'new-step-timer',
      name: '焖煮',
      mode: 'countdown',
      durationSeconds: 480,
      source: 'step',
      stepId: 'step-2',
    }));
  });

  it('selects an existing timer for the step instead of creating a duplicate', () => {
    const existingStepTimer = timer({
      id: 'step-timer',
      name: '焖煮',
      mode: 'countdown',
      durationSeconds: 480,
      source: 'step',
      stepId: 'step-2',
    });
    const timers = [timer({ running: true }), existingStepTimer];

    const result = transition(timers, 'timer-1', step('step-2', '焖煮', 8));

    expect(result).toEqual({ timers, activeTimerId: 'step-timer' });
  });

  it('does not change timers for a step without a recommendation or the current step', () => {
    const timers = [timer()];

    expect(transition(timers, 'timer-1', step('step-2', '装盘', null))).toEqual({
      timers,
      activeTimerId: 'timer-1',
    });
    expect(transitionCookTimerForStep({
      timers,
      activeTimerId: 'timer-1',
      currentStepIndex: 0,
      nextStepIndex: 0,
      nextStep: step('step-1', '备菜', 3),
      newTimerId: 'unused',
    })).toEqual({
      timers,
      activeTimerId: 'timer-1',
    });
  });
});

describe('cook timer helpers', () => {
  it('advances running timers by elapsed wall-clock time', () => {
    const result = advanceCookTimers([
      timer({ running: true, seconds: 3, lastTickedAt: 1_000 }),
    ], 6_250);

    expect(result.newlyFinishedTimerId).toBeNull();
    expect(result.timers[0]).toEqual(timer({
      running: true,
      seconds: 8,
      lastTickedAt: 6_000,
    }));
  });

  it('finishes countdown timers after background elapsed time', () => {
    const result = advanceCookTimers([
      timer({
        mode: 'countdown',
        durationSeconds: 10,
        seconds: 4,
        running: true,
        lastTickedAt: 1_000,
      }),
    ], 8_500);

    expect(result.newlyFinishedTimerId).toBe('timer-1');
    expect(result.timers[0]).toEqual(timer({
      mode: 'countdown',
      durationSeconds: 10,
      seconds: 10,
      running: false,
      lastTickedAt: null,
    }));
  });

  it('uses the first available custom timer number', () => {
    expect(getNextManualTimerName([
      timer({ name: '自定义 1' }),
      timer({ name: '自定义 3' }),
      timer({ name: '焖煮', source: 'step', stepId: 'step-2' }),
    ])).toBe('自定义 2');
  });

  it('selects the next adjacent timer, then the previous one, when deleting the active timer', () => {
    const timers = [
      timer({ id: 'a' }),
      timer({ id: 'b' }),
      timer({ id: 'c' }),
    ];

    expect(removeCookTimer(timers, 'b', 'b').activeTimerId).toBe('c');
    expect(removeCookTimer(timers, 'c', 'c').activeTimerId).toBe('b');
  });
});
