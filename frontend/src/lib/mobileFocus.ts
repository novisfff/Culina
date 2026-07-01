export function focusMobileInput(inputId: string, options?: { containerSelector?: string }) {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) return;

  input.focus({ preventScroll: true });
  const selectionPosition = input.value.length;
  input.setSelectionRange(selectionPosition, selectionPosition);

  const scrollTarget =
    (options?.containerSelector ? input.closest(options.containerSelector) : null) ??
    input.closest('label') ??
    input;
  scrollTarget.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

  window.requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
  });
}
