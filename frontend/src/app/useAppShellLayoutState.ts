import { useEffect, useState } from 'react';
import { readStringStorage, writeStringStorage } from '../lib/storage';

const SIDEBAR_COLLAPSED_KEY = 'culina-large-shell-sidebar-collapsed-v3';
const PHONE_VIEWPORT_QUERY = '(max-width: 767px)';

function getIsPhoneViewport() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_VIEWPORT_QUERY).matches
    : false;
}

export function useAppShellLayoutState() {
  const [isPhoneViewport, setIsPhoneViewport] = useState(getIsPhoneViewport);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStringStorage(SIDEBAR_COLLAPSED_KEY, '') === '1',
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const handleChange = () => setIsPhoneViewport(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    writeStringStorage(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  return { isPhoneViewport, sidebarCollapsed, setSidebarCollapsed };
}
