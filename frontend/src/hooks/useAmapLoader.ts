import { useEffect, useState } from 'react';

/** 高德 JS API 的最小类型声明（只用到 Map / Marker） */
export interface AmapMapInstance {
  setCenter: (position: [number, number]) => void;
  setZoom: (zoom: number) => void;
  add: (overlay: unknown) => void;
  remove: (overlay: unknown) => void;
  destroy: () => void;
}

export interface AmapNamespace {
  Map: new (container: HTMLElement | string, opts?: Record<string, unknown>) => AmapMapInstance;
  Marker: new (opts?: Record<string, unknown>) => unknown;
  Pixel?: new (x: number, y: number) => unknown;
}

interface AmapWindow extends Window {
  AMap?: AmapNamespace;
  _AMapSecurityConfig?: { securityJsCode?: string };
}

export type AmapStatus = 'fallback' | 'loading' | 'ready';

const SCRIPT_ID = 'gbaccessmap-amap-script';
const LOAD_TIMEOUT_MS = 6000;

export function getAmapKey(): string {
  const raw = import.meta.env.VITE_AMAP_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

export interface AmapLoaderResult {
  status: AmapStatus;
  amap: AmapNamespace | null;
  error: string;
  /** 是否配置了 key */
  hasKey: boolean;
  /** 是否使用本地 SVG 网格降级视图 */
  usingFallback: boolean;
}

/**
 * 按需注入高德 JS API。
 * key 为空时**绝不发起任何网络请求**，直接返回降级标记，
 * 由 MapPanel 渲染本地 SVG 网格视图；脚本加载失败/超时同样降级。
 */
export function useAmapLoader(): AmapLoaderResult {
  const key = getAmapKey();
  const [status, setStatus] = useState<AmapStatus>(() => (key ? 'loading' : 'fallback'));
  const [amap, setAmap] = useState<AmapNamespace | null>(null);
  const [error, setError] = useState(() =>
    key ? '' : '未配置 VITE_AMAP_KEY，已启用本地 SVG 网格视图',
  );

  useEffect(() => {
    // 关键：没有 key 就直接降级，禁止请求 webapi.amap.com
    if (!key) {
      setStatus('fallback');
      setAmap(null);
      setError('未配置 VITE_AMAP_KEY，已启用本地 SVG 网格视图');
      return;
    }

    const win = window as AmapWindow;
    if (win.AMap) {
      setAmap(win.AMap);
      setStatus('ready');
      return;
    }

    let cancelled = false;
    let timer = 0;

    const fallback = (msg: string) => {
      if (cancelled) return;
      setStatus('fallback');
      setError(msg);
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      timer = window.setTimeout(() => fallback('高德 JS API 加载超时，已启用网格视图'), LOAD_TIMEOUT_MS);
      const onChange = () => {
        if (win.AMap) {
          window.clearTimeout(timer);
          setAmap(win.AMap);
          setStatus('ready');
        }
      };
      existing.addEventListener('load', onChange);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
        existing.removeEventListener('load', onChange);
      };
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onload = () => {
      window.clearTimeout(timer);
      if (cancelled) return;
      if (win.AMap) {
        setAmap(win.AMap);
        setStatus('ready');
      } else {
        fallback('高德 JS API 未返回可用对象，已启用网格视图');
      }
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      fallback('高德 JS API 加载失败，已启用网格视图');
    };
    timer = window.setTimeout(() => fallback('高德 JS API 加载超时，已启用网格视图'), LOAD_TIMEOUT_MS);
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key]);

  return {
    status,
    amap,
    error,
    hasKey: Boolean(key),
    usingFallback: status === 'fallback',
  };
}
