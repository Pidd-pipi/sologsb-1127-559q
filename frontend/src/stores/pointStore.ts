import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import type { SyncEntity } from '../types/sync';
import { makeId, toPlain, todayStr } from '../utils/format';
import { bumpRevision, getDeviceId } from '../sync/revision';
import { affectedSegments, deriveSegmentState } from '../utils/routeLive';

type SyncedPoint = SyncEntity<AccessPoint>;
type SyncedInspection = SyncEntity<Inspection>;
type SyncedRectify = SyncEntity<RectifyPlan>;

const POINT_FIELDS = [
  'code',
  'name',
  'facilityType',
  'lng',
  'lat',
  'district',
  'location',
  'builtYear',
  'maintainUnit',
  'createdAt',
  'updatedAt',
];
const INSPECTION_FIELDS = [
  'pointId',
  'date',
  'inspector',
  'slope',
  'clearWidth',
  'hasHandrail',
  'tactileContinuous',
  'occupied',
  'conclusion',
  'problem',
  'createdAt',
];
const RECTIFY_FIELDS = ['pointId', 'requirement', 'unit', 'deadline', 'recheckDate', 'status', 'createdAt'];

/**
 * 点位变化或最新核验结论变化后，相关路段立即失效重算。
 * 判定始终用最新点位 + 最新核验实时派生，旧全线结论不会继续显示。
 */
async function invalidateRoutesFor(pointIds: string[]): Promise<void> {
  if (!pointIds.length) return;
  const touched = new Set(pointIds);
  const [segments, points, inspections] = await Promise.all([
    db.routes.toArray(),
    db.points.toArray(),
    db.inspections.toArray(),
  ]);
  const impacted = affectedSegments(segments, touched);
  if (!impacted.length) return;
  const ctx = { points, inspections };
  await Promise.all(
    impacted.map((seg) => {
      const state = deriveSegmentState(seg, ctx);
      return db.routes.put({
        ...seg,
        length: Math.round(state.derivedLength * 10) / 10,
        validState: state.state,
        invalidReason: state.state === 'invalid' ? state.reasons.join('；') : '',
      });
    }),
  );
}

interface PointState {
  points: SyncedPoint[];
  inspections: SyncedInspection[];
  rectifies: SyncedRectify[];
  loading: boolean;
  loaded: boolean;
  error: string;
  /** 数据版本：导入应用后自增，供其他 store 联动刷新 */
  dataVersion: number;
  load: () => Promise<void>;
  reloadAll: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => SyncedPoint | undefined;
  inspectionsOf: (pointId: string) => SyncedInspection[];
  rectifiesOf: (pointId: string) => SyncedRectify[];
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',
  dataVersion: 0,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      await get().reloadAll();
      set({ loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  reloadAll: async () => {
    const [points, inspections, rectifies] = await Promise.all([
      db.points.toArray(),
      db.inspections.toArray(),
      db.rectifies.toArray(),
    ]);
    set({
      points: points.sort((a, b) => a.code.localeCompare(b.code)),
      inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
      rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
      dataVersion: get().dataVersion + 1,
    });
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const base: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    const point = bumpRevision(
      null,
      base as unknown as Record<string, unknown>,
      getDeviceId(),
      now,
      POINT_FIELDS,
    ) as unknown as SyncedPoint;
    await db.points.put(point);
    set((s) => ({
      points: [...s.points, point as SyncedPoint].sort((a, b) => a.code.localeCompare(b.code)),
      dataVersion: s.dataVersion + 1,
    }));
    return point as unknown as AccessPoint;
  },

  addInspection: async (draft) => {
    const now = new Date().toISOString();
    const base: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: now,
    });
    const inspection = bumpRevision(
      null,
      base as unknown as Record<string, unknown>,
      getDeviceId(),
      now,
      INSPECTION_FIELDS,
    ) as unknown as SyncedInspection;
    await db.inspections.put(inspection);
    set((s) => ({
      inspections: [inspection, ...s.inspections].sort((a, b) => (a.date < b.date ? 1 : -1)),
      dataVersion: s.dataVersion + 1,
    }));
    // 最新核验结论变化：相关路段立即失效重算
    await invalidateRoutesFor([inspection.pointId]);
    // 结论为不合格时自动生成整改条目，形成闭环
    if (inspection.conclusion === '不合格') {
      const exists = get().rectifies.some(
        (r) => r.pointId === inspection.pointId && r.status !== '已整改',
      );
      if (!exists) {
        await get().addRectify({
          pointId: inspection.pointId,
          requirement: `按 ${inspection.date} 核验结论整改：${inspection.problem || '坡度、净宽或占用问题'}`,
          unit: '待指派责任单位',
          deadline: todayStr(),
          recheckDate: '',
          status: '待整改',
        });
      }
    }
    return inspection;
  },

  addRectify: async (draft) => {
    const now = new Date().toISOString();
    const base: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: now,
    });
    const plan = bumpRevision(
      null,
      base as unknown as Record<string, unknown>,
      getDeviceId(),
      now,
      RECTIFY_FIELDS,
    ) as unknown as SyncedRectify;
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
      dataVersion: s.dataVersion + 1,
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const prev = await db.rectifies.get(id);
    if (!prev) return;
    const now = new Date().toISOString();
    const next: Record<string, unknown> = { ...(prev as unknown as Record<string, unknown>), ...toPlain(patch) };
    const stamped = bumpRevision(
      prev as unknown as Record<string, unknown> | null,
      next,
      getDeviceId(),
      now,
      RECTIFY_FIELDS,
    ) as unknown as SyncedRectify;
    await db.rectifies.put(stamped);
    set((s) => ({
      rectifies: s.rectifies
        .map((r) => (r.id === id ? stamped : r))
        .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
      dataVersion: s.dataVersion + 1,
    }));
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
}));
