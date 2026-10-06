import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { RouteSegment } from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { judgeSegment, buildVerdict } from '../utils/routeCheck';
import { segmentLength } from '../utils/geo';
import type { RouteVerdict } from '../types/route';

/** 编辑中的路段（尚未落库） */
export interface DraftSegment {
  key: string;
  fromPointId: string;
  toPointId: string;
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  order: number;
}

interface RouteState {
  segments: RouteSegment[];
  loaded: boolean;
  loading: boolean;
  error: string;
  draftName: string;
  chain: string[];
  draftSegments: DraftSegment[];
  verdict: RouteVerdict | null;
  load: () => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[]) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  computeVerdict: () => RouteVerdict;
  saveRoute: () => Promise<number>;
  resetDraft: () => void;
}

function newKey(): string {
  return `seg-${Math.random().toString(36).slice(2, 9)}`;
}

export const useRouteStore = create<RouteState>((set, get) => ({
  segments: [],
  loaded: false,
  loading: false,
  error: '',
  draftName: '无障碍通行路线',
  chain: [],
  draftSegments: [],
  verdict: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const rows = await db.routes.toArray();
      set({
        segments: rows.sort((a, b) =>
          a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
        ),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setDraftName: (name) => set({ draftName: name }),

  setChain: (ids) => set({ chain: ids, verdict: null }),

  toggleChainPoint: (id) => {
    const chain = get().chain;
    set({
      chain: chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id],
      verdict: null,
    });
  },

  /** 选好起终点与途经点后自动串联路段 */
  buildChainSegments: (points) => {
    const chain = get().chain;
    const byId = new Map(points.map((p) => [p.id, p]));
    const ordered = chain.map((id) => byId.get(id)).filter(Boolean) as AccessPoint[];
    const draftSegments: DraftSegment[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      draftSegments.push({
        key: newKey(),
        fromPointId: from.id,
        toPointId: to.id,
        length: segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat }),
        obstacleCount: 0,
        stepCount: 0,
        curbHeight: 2,
        order: i,
      });
    }
    set({ draftSegments, verdict: null });
  },

  updateDraftSegment: (key, patch) =>
    set((s) => ({
      draftSegments: s.draftSegments.map((seg) => (seg.key === key ? { ...seg, ...patch } : seg)),
      verdict: null,
    })),

  removeDraftSegment: (key) =>
    set((s) => ({
      draftSegments: s.draftSegments
        .filter((seg) => seg.key !== key)
        .map((seg, i) => ({ ...seg, order: i + 1 })),
      verdict: null,
    })),

  computeVerdict: () => {
    const { draftSegments, draftName } = get();
    const verdict = buildVerdict(draftName, draftSegments);
    set({ verdict });
    return verdict;
  },

  saveRoute: async () => {
    const { draftSegments, draftName } = get();
    const rows: RouteSegment[] = draftSegments.map((seg) =>
      toPlain({
        id: makeId('rts'),
        routeName: draftName || '未命名路线',
        fromPointId: seg.fromPointId,
        toPointId: seg.toPointId,
        length: seg.length,
        obstacleCount: seg.obstacleCount,
        stepCount: seg.stepCount,
        curbHeight: seg.curbHeight,
        wheelchairPassable: judgeSegment(seg).passable,
        order: seg.order,
        createdAt: new Date().toISOString(),
      }),
    );
    if (!rows.length) return 0;
    await db.routes.bulkPut(rows);
    const all = await db.routes.toArray();
    set({
      segments: all.sort((a, b) =>
        a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
      ),
    });
    return rows.length;
  },

  resetDraft: () => set({ draftSegments: [], verdict: null, chain: [] }),
}));
