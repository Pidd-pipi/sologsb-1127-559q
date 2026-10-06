import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PREFIX = 'gbaccessmap-draft:';

export interface LocalDraftResult<T> {
  draft: T;
  /** 合并式更新，自动写入 localStorage */
  patch: (next: Partial<T>) => void;
  replace: (next: T) => void;
  reset: () => void;
  /** 最近一次落盘时间，空字符串表示尚未保存 */
  savedAt: string;
  existed: boolean;
}

/**
 * 表单草稿：localStorage 持久化（业务数据仍走 IndexedDB）。
 * 刷新页面后草稿自动回填，避免登记到一半丢失。
 */
export function useLocalDraft<T extends object>(key: string, initial: T): LocalDraftResult<T> {
  const storageKey = `${PREFIX}${key}`;
  const initialRef = useRef(initial);

  const [draft, setDraft] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return { ...initialRef.current, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      /* 读取失败时退回初始值 */
    }
    return initialRef.current;
  });
  const [savedAt, setSavedAt] = useState('');
  const existed = useMemo(() => {
    try {
      return Boolean(localStorage.getItem(storageKey));
    } catch {
      return false;
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch {
      /* 存储不可用时静默降级为纯内存草稿 */
    }
  }, [storageKey, draft]);

  const patch = useCallback((next: Partial<T>) => {
    setDraft((cur) => ({ ...cur, ...next }));
  }, []);

  const replace = useCallback((next: T) => setDraft(next), []);

  const reset = useCallback(() => {
    setDraft(initialRef.current);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* 忽略 */
    }
    setSavedAt('');
  }, [storageKey]);

  return { draft, patch, replace, reset, savedAt, existed };
}
