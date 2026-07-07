import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function ActionButton(
  props: {
    tone?: 'primary' | 'secondary' | 'tertiary';
    size?: 'default' | 'compact';
    className?: string;
    children: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>
) {
  const { tone = 'secondary', size = 'default', className, children, ...buttonProps } = props;
  const classes = [
    tone === 'primary' ? 'solid-button' : tone === 'tertiary' ? 'tertiary-button' : 'ghost-button',
  ];
  if (size === 'compact') {
    classes.push('button-compact');
  }
  if (className) {
    classes.push(className);
  }
  return (
    <button {...buttonProps} className={classes.join(' ')}>
      {children}
    </button>
  );
}
