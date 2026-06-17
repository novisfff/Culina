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

    expect(container.textContent).toContain('库存处理项');
    expect(container.textContent).toContain('销毁');
    expect(container.textContent).toContain('销毁数量');
    expect(container.textContent).toContain('销毁原因');
    expect(container.textContent).not.toContain('处理方式');
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('.ai-inventory-dispose-reason textarea')?.value).toBe('包装破损');
    expect(container.querySelector('.ai-inventory-operation-item.action-dispose')).not.toBeNull();
  });

  it('keeps restock details collapsed until requested', async () => {
    const approval: AiApprovalRequest = {
      id: 'approval-restock',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      run_id: 'run-1',
      draft_id: 'draft-restock',
      draft_version: 1,
      draft_schema_version: 'inventory_operation.v1',
      approval_type: 'inventory.operation',
      status: 'pending',
      title: '确认补货',
      instruction: '确认后会正式修改家庭库存。',
      approve_label: '确认补货',
      reject_label: '暂不处理',
      require_reject_comment: false,
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_operation',
          schemaVersion: 'inventory_operation.v1',
          operations: [{
            action: 'restock',
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            quantity: 1,
            unit: '个',
            purchaseDate: '2026-06-14',
            expiryDate: '2026-06-20',
            storageLocation: '冷藏',
            status: 'fresh',
            notes: '',
            reason: '',
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

    expect(container.textContent).toContain('更多入库信息');
    expect(container.textContent).not.toContain('采购日期');
    const toggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '更多入库信息');
    await act(async () => toggle?.click());
    expect(container.textContent).toContain('采购日期');
    expect(container.textContent).toContain('存放位置');
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
    expect(container.querySelector('select')?.textContent).toContain('到期 2026-06-16 · 冷藏 · 剩余 2个');
  });
});
