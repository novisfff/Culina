import { useCallback, useState } from 'react';

const TABLET_COLLAPSE_MAX_WIDTH = 1280;
const STORAGE_KEY = 'ai_sidebar_collapsed';

export function isTabletAiWorkspaceViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= TABLET_COLLAPSE_MAX_WIDTH;
}

export function resolveInitialAiSidebarCollapsed() {
  if (isTabletAiWorkspaceViewport()) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistAiSidebarCollapsed(collapsed: boolean) {
  if (isTabletAiWorkspaceViewport()) return;
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch (error) {
    console.warn(error);
  }
}

export function useAiSidebarState() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(resolveInitialAiSidebarCollapsed);
  const toggleSidebar = useCallback((collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    persistAiSidebarCollapsed(collapsed);
  }, []);
  return { isSidebarCollapsed, toggleSidebar };
}
