import { useCallback, useSyncExternalStore } from 'react';
import { useAuthStore } from '../stores/auth.ts';

export type DisplayMode = 'chat' | 'compact';

const DEFAULT_MODE: DisplayMode = 'chat';
const listeners = new Set<() => void>();
const DISPLAY_MODE_PREFIX = 'happypaw-display-mode:';
const legacyDisplayModePrefix = DISPLAY_MODE_PREFIX.replaceAll('paw', 'claw');

function getStorageKey(userId: string | null | undefined): string {
  return `${DISPLAY_MODE_PREFIX}${userId || 'guest'}`;
}

function getLegacyStorageKey(userId: string | null | undefined): string {
  return `${legacyDisplayModePrefix}${userId || 'guest'}`;
}

function readMode(storageKey: string): DisplayMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const legacyStorageKey = storageKey.replace(
    DISPLAY_MODE_PREFIX,
    legacyDisplayModePrefix,
  );
  const stored =
    window.localStorage.getItem(storageKey)
    ?? window.localStorage.getItem(legacyStorageKey);
  return stored === 'compact' ? 'compact' : DEFAULT_MODE;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDisplayMode() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const storageKey = getStorageKey(userId);
  const legacyStorageKey = getLegacyStorageKey(userId);
  const getSnapshot = useCallback(() => readMode(storageKey), [storageKey]);
  const setMode = useCallback(
    (mode: DisplayMode) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, mode);
        window.localStorage.removeItem(legacyStorageKey);
      }
      listeners.forEach((cb) => cb());
    },
    [legacyStorageKey, storageKey],
  );
  const mode = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_MODE);
  const toggle = useCallback(() => {
    setMode(mode === 'chat' ? 'compact' : 'chat');
  }, [mode, setMode]);
  return { mode, toggle, setMode };
}
