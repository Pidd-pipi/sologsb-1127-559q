import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import type { EntityKind } from '../types/sync';

/** 参与逐字段合并的字段（元信息、id 类字段不参与） */
export const MERGE_FIELDS: Record<EntityKind, string[]> = {
  point: [
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
  ],
  inspection: [
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
  ],
  rectify: [
    'pointId',
    'requirement',
    'unit',
    'deadline',
    'recheckDate',
    'status',
    'createdAt',
  ],
  route: [
    'routeName',
    'fromPointId',
    'toPointId',
    'length',
    'obstacleCount',
    'stepCount',
    'curbHeight',
    'order',
    'createdAt',
  ],
};

/** 冲突裁决界面上的字段中文名 */
export const FIELD_LABELS: Record<EntityKind, Record<string, string>> = {
  point: {
    code: '点位编号',
    name: '点位名称',
    facilityType: '设施类型',
    lng: '经度',
    lat: '纬度',
    district: '行政区',
    location: '所在道路或建筑',
    builtYear: '建成年代',
    maintainUnit: '养护单位',
    createdAt: '创建时间',
  },
  inspection: {
    pointId: '所属点位',
    date: '核验日期',
    inspector: '核验人',
    slope: '坡度%',
    clearWidth: '净宽cm',
    hasHandrail: '扶手',
    tactileContinuous: '盲道连续性',
    occupied: '占用情况',
    conclusion: '核验结论',
    problem: '问题描述',
    createdAt: '创建时间',
  },
  rectify: {
    pointId: '所属点位',
    requirement: '整改要求',
    unit: '责任单位',
    deadline: '整改期限',
    recheckDate: '复检日期',
    status: '状态',
    createdAt: '创建时间',
  },
  route: {
    routeName: '路线名称',
    fromPointId: '起点',
    toPointId: '终点',
    length: '长度m',
    obstacleCount: '障碍数',
    stepCount: '台阶数',
    curbHeight: '路缘高差cm',
    order: '段序',
    createdAt: '创建时间',
  },
};

export const ENTITY_LABEL: Record<EntityKind, string> = {
  point: '点位',
  inspection: '核验记录',
  rectify: '整改条目',
  route: '路线段',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntityLike = any;

export function entityLabel(kind: EntityKind, entity: AnyEntityLike): string {
  const name =
    kind === 'point'
      ? (entity as unknown as AccessPoint).name
      : kind === 'inspection'
        ? `核验 ${(entity as unknown as Inspection).date}（${(entity as unknown as Inspection).inspector}）`
        : kind === 'rectify'
          ? (entity as unknown as RectifyPlan).requirement
          : `路段 第${(entity as unknown as RouteSegment).order}段`;
  return `${ENTITY_LABEL[kind]} ${name}`;
}

/** 归一化比较值（去空格字符串） */
function norm(v: unknown): unknown {
  return typeof v === 'string' ? v.trim() : v;
}

/** 字段值是否相等 */
export function sameValue(a: unknown, b: unknown): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (typeof na === 'number' && typeof nb === 'number') return Math.abs(na - nb) < 1e-9;
  return false;
}

/**
 * 核验记录指纹：同一点位、同一天、同一核验人、同一组实测值即视为同一次核验。
 * 同一核验重复回传只补一次，跳过重复。
 */
export function inspectionFingerprint(ins: Inspection): string {
  return [
    ins.pointId,
    ins.date,
    ins.inspector?.trim() ?? '',
    ins.slope,
    ins.clearWidth,
    ins.hasHandrail ? 1 : 0,
    ins.tactileContinuous ? 1 : 0,
    ins.occupied,
    ins.conclusion,
    (ins.problem ?? '').trim(),
  ].join('|');
}

/** 整改条目指纹：同点位 + 要求 + 期限视为同一条 */
export function rectifyFingerprint(plan: RectifyPlan): string {
  return [plan.pointId, plan.requirement.trim(), plan.unit.trim(), plan.deadline].join('|');
}

/** 路线段指纹：同名路线的相邻两点位同向段视为同一段 */
export function routeFingerprint(seg: RouteSegment): string {
  return [seg.routeName.trim(), seg.fromPointId, seg.toPointId, seg.order].join('|');
}
