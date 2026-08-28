import { useEffect } from 'react';

export type NavigationEffectIdentity = {
  primaryTab: string;
  eatBaseView: string;
  taskKind: string | undefined;
  familyView: string;
};

export function navigationEffectKey(identity: NavigationEffectIdentity): string {
  return [identity.primaryTab, identity.eatBaseView, identity.taskKind ?? '', identity.familyView].join('|');
}

function resetScroll() {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.app-content')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
}

export function useAppNavigationEffects(identity: NavigationEffectIdentity): void {
  const key = navigationEffectKey(identity);
  useEffect(() => { resetScroll(); }, [key]);
}
