import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelIntegerField } from './ModelIntegerField';

describe('ModelIntegerField', () => {
  it('keeps incomplete and out-of-range edits local and commits valid integers on blur', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const validity = vi.fn();
    render(<ModelIntegerField label="模型维度" value={1536} max={65536} disabled={false} onChange={onChange} onValidityChange={validity} />);
    const input = screen.getByLabelText('模型维度');
    await user.clear(input);
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    for (const invalid of ['65537', '1.5', '-1']) {
      await user.clear(input);
      await user.type(input, invalid);
      await user.tab();
      expect(onChange).not.toHaveBeenCalled();
    }
    await user.clear(input);
    await user.type(input, '3072');
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(3072);
    expect(validity).toHaveBeenLastCalledWith(true);
  });
});
