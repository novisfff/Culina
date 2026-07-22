import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AiApprovalRequest } from '../../api/types';
import { ApprovalPanel } from './AiApprovalPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('inventory operation approval', () => {
  it('renders a structured destructive-operation editor', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-inventory',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-inventory',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认处理库存',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认处理库存',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'dispose',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            inventoryItemId: 'inventory-tomato',
            quantity: 2,
            unit: '个',
            notes: '',
            reason: '包装破损',
            remainingQuantity: 2,
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={vi.fn()} />);
    });

    expect(container.textContent).toContain('主要处理项');
    expect(container.textContent).toContain('销毁');
    expect(container.textContent).toContain('销毁数量');
    expect(container.textContent).toContain('销毁原因');
    expect(container.textContent).not.toContain('处理方式');
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('.ai-inventory-dispose-reason textarea')?.value).toBe('包装破损');
    expect(container.querySelector('.ai-inventory-operation-item.action-dispose')).not.toBeNull();
  });



  it('preserves hidden concurrency boundaries when editing an exact quantity', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const approval: AiApprovalRequest = {
      id: 'approval-versioned-consume',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-versioned-consume',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认消耗',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认消耗',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'consume',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            quantityTrackingMode: 'track_quantity',
            expectedIngredientRowVersion: 7,
            stateId: null,
            expectedStateRowVersion: null,
            expectedInventoryItemRowVersion: null,
            inventoryItemId: null,
            quantity: 1,
            unit: '个',
            notes: '',
            reason: '',
            batchOptions: [{
              id: 'inventory-tomato',
              label: '到期 2026-06-16 · 冷藏',
              remainingQuantity: 3,
              unit: '个',
              rowVersion: 4,
            }],
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={onDecision} />);
    });

    const quantity = container.querySelector<HTMLInputElement>('.quantity-input');
    expect(quantity).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(quantity, '2');
      quantity?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const approve = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认消耗');
    await act(async () => approve?.click());

    const submitted = onDecision.mock.calls[0][2] as { draft: { operations: Array<Record<string, unknown>> } };
    expect(submitted.draft.operations[0]).toMatchObject({
      quantity: 2,
      quantityTrackingMode: 'track_quantity',
      expectedIngredientRowVersion: 7,
      expectedInventoryItemRowVersion: null,
      batchOptions: [expect.objectContaining({ id: 'inventory-tomato', rowVersion: 4 })],
    });
  });

  it('uses expiring-first consumption and reveals readable batch choices on demand', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-consume',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-consume',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认消耗',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认消耗',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'consume',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            inventoryItemId: null,
            quantity: 1,
            unit: '个',
            notes: '',
            reason: '',
            batchOptions: [{
              id: 'inventory-tomato',
              label: '到期 2026-06-16 · 冷藏',
              remainingQuantity: 2,
              unit: '个',
              expiryDate: '2026-06-16',
            }],
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={vi.fn()} />);
    });

    expect(container.textContent).toContain('默认按临期优先扣减');
    expect(container.querySelector('select')).toBeNull();
    const toggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '指定库存批次');
    await act(async () => toggle?.click());
    const batchTrigger = Array.from(container.querySelectorAll<HTMLButtonElement>('.ai-single-select-trigger')).find((button) => button.textContent === '自动按临期优先');
    await act(async () => batchTrigger?.click());
    expect(container.querySelector('.ai-resource-menu')?.textContent).toContain('到期 2026-06-16 · 冷藏 · 剩余 2个');
  });

  it('does not offer automatic scope expansion when the draft fixed one consume batch', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-explicit-consume',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-explicit-consume',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认消耗',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认消耗',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'consume',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            expectedIngredientRowVersion: 7,
            inventoryItemId: 'inventory-tomato',
            expectedInventoryItemRowVersion: 4,
            quantity: 1,
            unit: '个',
            notes: '',
            reason: '',
            batchOptions: [{
              id: 'inventory-tomato',
              label: '到期 2026-06-16 · 冷藏',
              remainingQuantity: 2,
              unit: '个',
              expiryDate: '2026-06-16',
              rowVersion: 4,
            }],
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={vi.fn()} />);
    });

    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '指定库存批次',
    );
    await act(async () => toggle?.click());
    const batchTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.ai-single-select-trigger'),
    ).find((button) => button.textContent?.includes('到期 2026-06-16'));
    await act(async () => batchTrigger?.click());

    expect(container.querySelector('.ai-resource-menu')?.textContent).not.toContain('自动按临期优先');
  });

  it('summarizes inventory impact and uses comboboxes for unit and storage location', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-inventory-summary',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-inventory-summary',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认库存处理',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认处理',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [
            {
              action: 'consume',
              ingredientId: 'ingredient-tomato',
              ingredientName: '番茄',
              inventoryItemId: null,
              quantity: 3,
              unit: '个',
              defaultUnit: '个',
              batchOptions: [{ id: 'inventory-tomato', label: '到期 2026-06-20 · 冷藏', remainingQuantity: 5, unit: '个' }],
            },
            {
              action: 'consume',
              ingredientId: 'ingredient-egg',
              ingredientName: '鸡蛋',
              inventoryItemId: null,
              quantity: 2,
              unit: '枚',
              batchOptions: [{ id: 'inventory-egg', label: '到期 2026-06-18 · 冷藏', remainingQuantity: 6, unit: '枚' }],
            },
            {
              action: 'dispose',
              ingredientId: 'ingredient-milk',
              ingredientName: '牛奶',
              inventoryItemId: 'inventory-milk',
              quantity: 1,
              unit: '瓶',
              reason: '已过期',
              remainingQuantity: 1,
              batchOptions: [{ id: 'inventory-milk', label: '到期 2026-06-10 · 冷藏', remainingQuantity: 1, unit: '瓶' }],
            },
          ],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={vi.fn()} />);
    });

    expect(container.textContent).toContain('待确认库存处理');
    expect(container.textContent).not.toContain('补货');
    expect(container.textContent).toContain('消耗2 项');
    expect(container.textContent).toContain('销毁1 项');
    expect(container.textContent).toContain('涉及食材3 种');
    expect(container.querySelectorAll('input[role="combobox"]').length).toBeGreaterThanOrEqual(3);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '更多入库信息')).toBe(false);
  });


  it('blocks manual consume batch ids that are not from the batch dropdown', async () => {
    const onDecision = vi.fn();
    const approval: AiApprovalRequest = {
      id: 'approval-invalid-batch',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-invalid-batch',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认消耗',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认消耗',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'consume',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            inventoryItemId: 'inventory-missing',
            quantity: 1,
            unit: '个',
            batchOptions: [{ id: 'inventory-tomato', label: '到期 2026-06-16 · 冷藏', remainingQuantity: 2, unit: '个' }],
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={onDecision} />);
    });

    const approve = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认消耗');
    await act(async () => approve?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('指定的库存批次必须从批次下拉中选择');
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('renders approved inventory operations as compact result cards', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-inventory-approved',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-inventory-approved',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'approved',
      title: '已处理库存',
      instruction: '库存已经处理。',
      approve_label: '确认处理',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'dispose',
            ingredientId: 'ingredient-milk',
            ingredientName: '牛奶',
            inventoryItemId: 'inventory-milk',
            quantity: 1,
            unit: '瓶',
            reason: '已过期',
            remainingQuantity: 1,
            batchOptions: [{ id: 'inventory-milk', label: '到期 2026-06-10 · 冷藏', remainingQuantity: 1, unit: '瓶' }],
          }],
        },
      },
      submitted_values: {},
      created_at: '2026-06-14T10:00:00Z',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ApprovalPanel approval={approval} onDecision={vi.fn()} />);
    });

    expect(container.textContent).toContain('库存处理结果');
    expect(container.textContent).toContain('处理结果');
    expect(container.querySelector('.ai-inventory-resolved-card')).not.toBeNull();
    expect(container.querySelector('.ai-inventory-operation-item')).toBeNull();
  });
});
