/**
 * 离线核验包同步模型
 *
 * 每个可同步实体（点位 / 核验记录 / 整改条目）带一份字段级修订号：
 * - rev：实体整体版本，实体每次被写入（含字段合并）自增；
 * - fieldRev：逐字段修订号，记录该字段最后一次被改动时的实体版本；
 * - deviceId / updatedAt：最近一次改动来源与时间，仅用于展示与审计，
 *   冲突裁决以 fieldRev 为准，不以时间先后为准（晚到的一份不能覆盖）。
 */

/** 实体类型标识，用于离线包与冲突表 */
export type EntityKind = 'point' | 'inspection' | 'rectify';

/** 逐字段修订号：键为业务字段名，值为该字段最后改动时的实体版本 */
export type FieldRevMap = Record<string, number>;

/** 可离线同步的实体公共元数据 */
export interface SyncMeta {
  /** 实体整体修订号，从 1 起，每次写入自增 */
  rev: number;
  /** 逐字段修订号 */
  fieldRev: FieldRevMap;
  /** 最近一次改动的设备（督导员端）标识 */
  deviceId: string;
  /** 最近一次改动时间 ISO 字符串 */
  syncedAt: string;
}

export type SyncEntity<T> = T & {
  rev: number;
  fieldRev: FieldRevMap;
  deviceId: string;
  syncedAt: string;
};

/** 点位字段修订元数据键 */
export type SyncMetaKey = 'rev' | 'fieldRev' | 'deviceId' | 'syncedAt';
export const SYNC_META_KEYS: SyncMetaKey[] = ['rev', 'fieldRev', 'deviceId', 'syncedAt'];

/**
 * 离线核验包：
 * 导出时为「下发包」（kind=export，携带基线快照供现场端离线改）；
 * 现场端回传时为「回传包」（kind=return，base 为导出时快照，entities 为改后实体）。
 */
export interface OfflinePackage {
  /** 包格式标识，用于导入校验 */
  format: 'gbaccessmap-offline';
  /** 包结构版本 */
  packageVersion: 1;
  kind: 'export' | 'return';
  /** 包 id；同一回传重复导入时据此幂等识别 */
  packageId: string;
  /** 下发包 id：回传包与其下发包一致，用于链路追踪 */
  exportId: string;
  /** 现场督导员端设备标识 */
  deviceId: string;
  createdAt: string;
  returnedAt?: string;
  /** 选中点位 id（导出锚点） */
  pointIds: string[];
  /** 导出时各实体的基线快照，三路合并的 base 侧 */
  base: PackagePayload;
  /** export 包：当前实体；return 包：现场端改后实体 */
  entities: PackagePayload;
  /** 备注，如督导员姓名 / 片区 */
  note?: string;
}

export interface PackagePayload {
  points: Array<SyncEntity<import('./point').AccessPoint>>;
  inspections: Array<SyncEntity<import('./inspection').Inspection>>;
  rectifies: Array<SyncEntity<import('./rectify').RectifyPlan>>;
}

/** 字段冲突的裁决选择 */
export type ConflictChoice = 'local' | 'remote';

/** 单个字段的三路合并结果 */
export interface FieldConflict {
  field: string;
  /** 字段中文名，用于并排裁决界面 */
  label: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  /** 基线（导出）修订号 */
  baseRev: number;
  /** 本地字段修订号 */
  localRev: number;
  /** 现场字段修订号 */
  remoteRev: number;
  /** 现场端是否改动（相对基线且值不同） */
  remoteChanged: boolean;
  /** 本地是否改动（相对基线且值不同） */
  localChanged: boolean;
  /** 两边都改且值不同 → true，必须并排裁决；否则可自动合并 */
  conflict: boolean;
  /** 自动合并时的既定取值来源；冲突时为 null，等待人工选择 */
  autoWinner: ConflictChoice | null;
}

export type MergeStatus = 'create' | 'update' | 'conflict';

/** 单个实体的合并计划（内部统一以宽松记录承载，合成时再收窄到具体类型） */
export interface EntityMergePlan {
  kind: EntityKind;
  id: string;
  status: MergeStatus;
  /** 本地实体（可能不存在，即现场新建） */
  local: Record<string, unknown> | null;
  /** 基线实体（可能不存在，即导出后现场或本地新建） */
  base: Record<string, unknown> | null;
  /** 现场回传实体 */
  remote: Record<string, unknown> | null;
  fields: FieldConflict[];
  /** 业务字段（排除 id 与同步元数据） */
  businessFields: string[];
  /** 裁决结果：字段 → 取值来源；未裁决的冲突字段不出现 */
  resolutions: Record<string, ConflictChoice>;
}

/** 预检结果：整包是否可落库 */
export interface PreflightResult {
  ok: boolean;
  /** 阻塞性错误：点位不足等，出现任意一条整包挂起，不写任何记录 */
  errors: string[];
  warnings: string[];
  /** 现场引用、但包内与本地都不存在的点位 id */
  missingPointIds: string[];
}

/** 合并预览（预检通过后生成，供并排裁决界面使用） */
export interface MergePreview {
  pkg: OfflinePackage;
  plans: EntityMergePlan[];
  conflictCount: number;
  /** 重复回传的核验指纹（本次跳过补录） */
  duplicateInspections: string[];
}

/** 暂存包（导入中断时整包留待重试）状态 */
export type StagedStatus = 'pending' | 'conflict' | 'applying' | 'applied' | 'failed';

export interface PackageRecord {
  id: string; // = packageId
  exportId: string;
  deviceId: string;
  kind: 'export' | 'return';
  status: StagedStatus;
  fileName: string;
  /** 原始包 JSON */
  payload: OfflinePackage;
  /** 最近一次裁决结果（冲突包挂起后可继续裁决） */
  resolutions: Record<string, Record<string, ConflictChoice>>;
  note?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

/** 已应用操作记录：导入中断重试时按 (packageId, opKey) 去重，保证整包只生效一次 */
export interface AppliedOp {
  /** packageId + ':' + opKey 的主键 */
  id: string;
  packageId: string;
  /** 操作键，如 point:<id> / inspection:<id> */
  opKey: string;
  entityKind: EntityKind;
  entityId: string;
  appliedAt: string;
}

/** 已见过的核验业务指纹：同一核验重复回传只补一次（跨包也生效） */
export interface SeenInspection {
  /** = fingerprint */
  id: string;
  pointId: string;
  date: string;
  inspector: string;
  /** 首次补录为它分配 / 命中的核验记录 id */
  inspectionId: string;
  packageId: string;
  seenAt: string;
}

/** 导入应用结果 */
export interface ApplyResult {
  packageId: string;
  applied: { points: number; inspections: number; rectifies: number };
  skippedDuplicateInspections: number;
  /** 因点位/核验变化而失效并已重算的路线段 id */
  invalidatedSegmentIds: string[];
}
