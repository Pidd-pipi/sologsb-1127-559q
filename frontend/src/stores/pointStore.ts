import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import { makeId, toPlain, todayStr } from '../utils/format';
import { invalidateAndRebuild } from '../sync/syncService';
import type { SyncedRecord } from '../types/sync';

const syncMeta = (): Pick<SyncedRecord, 'rev' | 'fieldRevs' | 'syncBase'> => ({
  rev: 1,
  fieldRevs: {},
  syncBase: null,
});

interface PointState {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  updatePoint: (id: string, patch: Partial<AccessPointDraft>) => Promise<void>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

const POINT_TRACKED: (keyof AccessPointDraft)[] = [
  'code',
  'name',
  'facilityType',
  'lng',
  'lat',
  'district',
  'location',
  'builtYear',
  'maintainUnit',
];
const RECTIFY_TRACKED: (keyof RectifyPlanDraft)[] = [
  'pointId',
  'requirement',
  'unit',
  'deadline',
  'recheckDate',
  'status',
];

/** 本机编辑：修订号 +1，被改字段的字段修订号 +1 */
function bump<T extends { rev: number; fieldRevs: Record<string, number> }>(
  row: T,
  patch: Record<string, unknown>,
  tracked: string[],
): T {
  const fieldRevs = { ...row.fieldRevs };
  for (const f of tracked) {
    if (f in patch) fieldRevs[f] = (fieldRevs[f] ?? 0) + 1;
  }
  return { ...row, ...patch, rev: row.rev + 1, fieldRevs };
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const [points, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      set({
        points: points.sort((a, b) => a.code.localeCompare(b.code)),
        inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
        rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
      ...syncMeta(),
    });
    await db.points.put(point);
    set((s) => ({ points: [...s.points, point].sort((a, b) => a.code.localeCompare(b.code)) }));
    return point;
  },

  updatePoint: async (id, patch) => {
    const existing = await db.points.get(id);
    if (!existing) return;
    const geometryChanged =
      ('lng' in patch && patch.lng !== existing.lng) || ('lat' in patch && patch.lat !== existing.lat);
    const updated: AccessPoint = toPlain(
      bump(
        { ...existing, updatedAt: new Date().toISOString() },
        patch as Record<string, unknown>,
        POINT_TRACKED,
      ),
    );
    await db.points.put(updated);
    set((s) => ({
      points: s.points.map((p) => (p.id === id ? updated : p)).sort((a, b) => a.code.localeCompare(b.code)),
    }));
    // 点位变化（含坐标移动）后，相关路线段立即失效重算
    if (geometryChanged) await invalidateAndRebuild(new Set([id]));
  },

  addInspection: async (draft) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
      ...syncMeta(),
    });
    await db.inspections.put(inspection);
    set((s) => ({
      inspections: [inspection, ...s.inspections].sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
    // 最新核验结论变化：相关路线段立即失效重算
    await invalidateAndRebuild(new Set([inspection.pointId]));
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
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: new Date().toISOString(),
      ...syncMeta(),
    });
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const existing = await db.rectifies.get(id);
    if (!existing) return;
    const updated: RectifyPlan = toPlain(
      bump(existing, patch as Record<string, unknown>, RECTIFY_TRACKED),
    );
    await db.rectifies.put(updated);
    set((s) => ({
      rectifies: s.rectifies.map((r) => (r.id === id ? updated : r)),
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
