import type { AccessPoint } from './point';
import type { Inspection } from './inspection';
import type { RectifyPlan } from './rectify';
import type { RouteSegment } from './route';

/** 可参与离线合并的实体类型 */
export type EntityKind = 'point' | 'inspection' | 'rectify' | 'route';

/**
 * 同步元信息：每个实体都带修订号。
 * - rev：实体级修订号，本机每改一次 +1
 * - fieldRevs：逐字段修订号，只有被改过的字段才登记（导出/合并按字段进行）
 * - syncBase：最近一次导出或合入时的字段快照，作为下次三路合并的共同基线
 * - sourcePackageId：核验记录来源核验包 id（同一核验重复回传只补一次）
 */
export interface SyncedRecord {
  rev: number;
  fieldRevs: Record<string, number>;
  syncBase?: Record<string, unknown> | null;
  sourcePackageId?: string;
}

/** 核验包内的单条实体：当前字段值 + 导出方基线 */
export interface PackageEntity<T> {
  entity: T;
  base: Record<string, unknown> | null;
}

export type AnyEntity = AccessPoint | Inspection | RectifyPlan | RouteSegment;

/** 离线核验包：督导员断网作业后回传的导出文件 */
export interface OfflinePackage {
  format: typeof PACKAGE_FORMAT;
  version: 1;
  packageId: string;
  exportedAt: string;
  exportedBy: string;
  deviceId: string;
  /** 导出时选中的点位 id */
  pointIds: string[];
  points: PackageEntity<AccessPoint>[];
  inspections: PackageEntity<Inspection>[];
  rectifies: PackageEntity<RectifyPlan>[];
  routes: PackageEntity<RouteSegment>[];
}

export const PACKAGE_FORMAT = 'gbaccessmap-offline-pack' as const;

/** 收件箱内导入包的处理状态 */
export type InboundStatus = '待重试' | '待裁决' | '已应用' | '已忽略';

export interface InboundPackage {
  /** 即 packageId，天然幂等键 */
  id: string;
  status: InboundStatus;
  payload: OfflinePackage;
  /** 待重试原因：结构错误、点位不足、事务中断等 */
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** 已应用核验包台账（幂等） */
export interface SyncLedgerEntry {
  id: string;
  appliedAt: string;
  exportedBy: string;
  pointCount: number;
  inspectionCount: number;
  rectifyCount: number;
  routeCount: number;
}

/** 字段冲突：两边都改过且取值不同，需要并排裁决 */
export interface FieldConflict {
  key: string;
  kind: EntityKind;
  entityId: string;
  entityLabel: string;
  field: string;
  fieldLabel: string;
  localValue: unknown;
  remoteValue: unknown;
  baseValue: unknown;
}

export type FieldChoice = 'local' | 'remote';

/** 裁决结果：键为 `${kind}:${entityId}:${field}` */
export type Adjudication = Record<string, FieldChoice>;

export const conflictKey = (kind: EntityKind, id: string, field: string): string =>
  `${kind}:${id}:${field}`;

export interface MergeCounters {
  added: number;
  updated: number;
  skipped: number;
  conflicted: number;
}

export interface MergeOutcome {
  points: MergeCounters;
  inspections: MergeCounters;
  rectifies: MergeCounters;
  routes: MergeCounters;
  /** 合并后需要写库的实体（已应用自动合并；含冲突时不含待裁决实体） */
  puts: {
    points: AccessPoint[];
    inspections: Inspection[];
    rectifies: RectifyPlan[];
    routes: RouteSegment[];
  };
  /** 本次合并命中过的点位 id：核验结论或点位变化，相关路线段要失效重算 */
  affectedPointIds: string[];
  conflicts: FieldConflict[];
  /** 预检阶段发现的缺失点位（包内引用、本地也没有） */
  missingPointIds: string[];
}

export const emptyCounters = (): MergeCounters => ({
  added: 0,
  updated: 0,
  skipped: 0,
  conflicted: 0,
});
