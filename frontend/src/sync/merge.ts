import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type {
  ConflictChoice,
  EntityKind,
  EntityMergePlan,
  FieldConflict,
  MergePreview,
  OfflinePackage,
  PackagePayload,
  PreflightResult,
  SyncEntity,
} from '../types/sync';
import { SYNC_META_KEYS } from '../types/sync';

/** 各实体业务字段中文名（并排裁决界面用） */
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
  },
  inspection: {
    pointId: '所属点位',
    date: '核验日期',
    inspector: '核验人',
    slope: '坡度(%)',
    clearWidth: '净宽(cm)',
    hasHandrail: '扶手',
    tactileContinuous: '盲道连续性',
    occupied: '占用情况',
    conclusion: '核验结论',
    problem: '问题描述',
  },
  rectify: {
    pointId: '所属点位',
    requirement: '整改要求',
    unit: '责任单位',
    deadline: '整改期限',
    recheckDate: '复检日期',
    status: '整改状态',
  },
};

/** 某类实体的业务字段（以现场实体自身键并集为准，排除 id 与同步元数据） */
export function businessFieldsOf(kind: EntityKind, ...rows: Array<Record<string, unknown> | null>): string[] {
  const order = Object.keys(FIELD_LABELS[kind]);
  const all = new Set<string>();
  for (const row of rows) {
    if (!row) continue;
    for (const k of Object.keys(row)) {
      if (k !== 'id' && !(SYNC_META_KEYS as string[]).includes(k)) all.add(k);
    }
  }
  // 已知字段按固定顺序，未知字段排末尾
  return [...order.filter((f) => all.has(f)), ...[...all].filter((f) => !order.includes(f))];
}

function getFieldRev(row: Record<string, unknown> | null, field: string): number {
  if (!row) return 0;
  const fr = row.fieldRev as Record<string, number> | undefined;
  // 兼容历史无 fieldRev 的数据：有 rev 视为整行同版本
  return fr?.[field] ?? (typeof row.rev === 'number' ? row.rev : 0);
}

/** 深比较两个值（JSON 语义，覆盖数字/布尔/字符串） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  // 数字与「非空数字串」归一后比较，避免 120 与 "120" 误判为改动；
  // 但 0 与空串必须视为不同（数值未填 vs 字段被清空）
  if (typeof a === 'number' || typeof b === 'number') {
    if (a === '' || b === '') return false;
    return Number(a) === Number(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 计算单个实体的逐字段三路合并计划。
 *
 * 修订号语义：
 * - 字段修订号 > 基线同字段修订号 且 值 != 基线值 → 该侧改过；
 * - 只有一侧改 → 自动取改过的一侧；
 * - 两侧都改且改成不同值 → 冲突，等待并排裁决，绝不以时间新旧覆盖。
 */
export function planEntity(
  kind: EntityKind,
  id: string,
  local: Record<string, unknown> | null,
  base: Record<string, unknown> | null,
  remote: Record<string, unknown> | null,
): EntityMergePlan {
  const fields = businessFieldsOf(kind, base, local, remote);
  const fieldPlans: FieldConflict[] = fields.map((field) => {
    const baseValue = base ? base[field] : undefined;
    const localValue = local ? local[field] : undefined;
    const remoteValue = remote ? remote[field] : undefined;
    const baseRev = getFieldRev(base, field);
    const localRev = getFieldRev(local, field);
    const remoteRev = getFieldRev(remote, field);

    const localChanged = Boolean(local) && (localRev > baseRev || !base) && !sameValue(localValue, baseValue);
    const remoteChanged =
      Boolean(remote) && (remoteRev > baseRev || !base) && !sameValue(remoteValue, baseValue);

    let status: Pick<FieldConflict, 'conflict' | 'autoWinner'>;
    if (localChanged && remoteChanged && !sameValue(localValue, remoteValue)) {
      if (localRev > remoteRev) {
        // 本地字段修订号更高：本地是更新的版本，晚到的现场旧值不覆盖
        status = { conflict: false, autoWinner: 'local' };
      } else if (remoteRev > localRev) {
        // 现场字段修订号更高：现场为新版本，自动取现场
        status = { conflict: false, autoWinner: 'remote' };
      } else {
        // 同修订号并发改成不同值：无法按版本排序，必须人工并排裁决
        status = { conflict: true, autoWinner: null };
      }
    } else if (localChanged && remoteChanged) {
      // 两边都改成同一个值：自动取任一侧即可
      status = { conflict: false, autoWinner: 'remote' };
    } else if (remoteChanged) {
      status = { conflict: false, autoWinner: 'remote' };
    } else if (localChanged) {
      status = { conflict: false, autoWinner: 'local' };
    } else {
      // 两侧都没改（修订号可能因无关字段整体自增）：取本地，无本地取现场
      status = { conflict: false, autoWinner: local ? 'local' : 'remote' };
    }

    return {
      field,
      label: FIELD_LABELS[kind][field] ?? field,
      baseValue,
      localValue,
      remoteValue,
      baseRev,
      localRev,
      remoteRev,
      remoteChanged,
      localChanged,
      conflict: status.conflict,
      autoWinner: status.autoWinner,
    };
  });

  const status = !local
    ? 'create'
    : fieldPlans.some((f) => f.conflict)
      ? 'conflict'
      : 'update';

  return {
    kind,
    id,
    status,
    local,
    base,
    remote,
    fields: fieldPlans,
    businessFields: fields,
    resolutions: {},
  };
}

type RowIndex = {
  point: Map<string, Record<string, unknown>>;
  inspection: Map<string, Record<string, unknown>>;
  rectify: Map<string, Record<string, unknown>>;
};

function indexPayload(payload: PackagePayload | undefined): RowIndex {
  const p = payload ?? { points: [], inspections: [], rectifies: [] };
  const toRow = (r: unknown) => r as Record<string, unknown>;
  return {
    point: new Map(p.points.map((r) => [r.id, toRow(r)])),
    inspection: new Map(p.inspections.map((r) => [r.id, toRow(r)])),
    rectify: new Map(p.rectifies.map((r) => [r.id, toRow(r)])),
  };
}

/** 现场数据中引用到的全部点位 id（核验 + 整改 + 包声明） */
export function referencedPointIds(pkg: OfflinePackage): Set<string> {
  const ids = new Set<string>(pkg.pointIds);
  for (const i of pkg.entities.inspections) ids.add(i.pointId);
  for (const r of pkg.entities.rectifies) ids.add(r.pointId);
  return ids;
}

/**
 * 预检：点位不足先不写。
 * 现场端引用的每个点位，必须在「包内现场点位」或「本地点位」中存在；
 * 缺任意一个，整包判定不可应用，调用方应整包挂起等待重试。
 */
export function preflight(
  pkg: OfflinePackage,
  local: { points: AccessPoint[] },
  seenFingerprints: Set<string>,
  fingerprintOf: (ins: Inspection) => string,
): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const remotePoints = new Set(pkg.entities.points.map((p) => p.id));
  const localPoints = new Set(local.points.map((p) => p.id));
  const missing: string[] = [];
  for (const pid of referencedPointIds(pkg)) {
    if (!remotePoints.has(pid) && !localPoints.has(pid)) missing.push(pid);
  }
  if (missing.length) {
    errors.push(
      `点位不足：${missing.length} 个被引用点位在包内与本地均缺失（${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''}），整包暂缓写入`,
    );
  }
  let dup = 0;
  for (const ins of pkg.entities.inspections) {
    if (seenFingerprints.has(fingerprintOf(ins))) dup += 1;
  }
  if (dup > 0) warnings.push(`其中 ${dup} 条核验为重复回传，将只补一次（自动跳过）`);
  if (pkg.kind !== 'return') {
    warnings.push('该包为下发查看包，不含现场改动；导入不会改动数据');
  }
  return { ok: errors.length === 0, errors, warnings, missingPointIds: missing };
}

/** 生成整包合并预览（含逐实体逐字段计划与冲突清单） */
export function buildMergePreview(
  pkg: OfflinePackage,
  local: {
    points: AccessPoint[];
    inspections: Inspection[];
    rectifies: RectifyPlan[];
  },
  seenFingerprints: Set<string>,
  fingerprintOf: (ins: Inspection) => string,
): MergePreview {
  const toRow = (r: unknown) => r as unknown as Record<string, unknown>;
  const localIdx = {
    point: new Map(local.points.map((r) => [r.id, toRow(r)])),
    inspection: new Map(local.inspections.map((r) => [r.id, toRow(r)])),
    rectify: new Map(local.rectifies.map((r) => [r.id, toRow(r)])),
  };
  const baseIdx = indexPayload(pkg.base);
  const remoteIdx = indexPayload(pkg.entities);

  const plans: EntityMergePlan[] = [];
  const kinds: EntityKind[] = ['point', 'inspection', 'rectify'];
  for (const kind of kinds) {
    const ids = new Set<string>([
      ...remoteIdx[kind].keys(),
      ...baseIdx[kind].keys(),
      ...localIdx[kind].keys(),
    ]);
    // 只处理与本包相关的实体：现场带回来的、或基线里有的；本地无关实体不动
    for (const id of ids) {
      if (!remoteIdx[kind].has(id) && !baseIdx[kind].has(id)) continue;
      plans.push(planEntity(kind, id, localIdx[kind].get(id) ?? null, baseIdx[kind].get(id) ?? null, remoteIdx[kind].get(id) ?? null));
    }
  }

  const duplicateInspections = pkg.entities.inspections
    .filter((i) => seenFingerprints.has(fingerprintOf(i)))
    .map((i) => i.id);

  const conflictCount = plans.reduce((n, p) => n + p.fields.filter((f) => f.conflict).length, 0);
  return { pkg, plans, conflictCount, duplicateInspections };
}

/** 冲突是否全部裁决（无冲突返回 true） */
export function allConflictsResolved(preview: MergePreview): boolean {
  return preview.plans.every((p) =>
    p.fields.filter((f) => f.conflict).every((f) => p.resolutions[f.field] === 'local' || p.resolutions[f.field] === 'remote'),
  );
}

export function unresolvedCount(preview: MergePreview): number {
  return preview.plans.reduce(
    (n, p) => n + p.fields.filter((f) => f.conflict && !p.resolutions[f.field]).length,
    0,
  );
}

/**
 * 按裁决结果合成最终实体。
 * 冲突字段取 resolutions 指定侧；非冲突字段取 autoWinner 指定侧。
 * 同时合并两侧的最高字段修订号，并把实体 rev 提升为「两侧 rev 的最大值 + 1」，
 * 保证合并产物版本严格新于双方，下一次同步任一侧的旧值都不会回灌覆盖。
 */
export function resolveEntity<T extends Record<string, unknown>>(
  plan: EntityMergePlan,
): SyncEntity<T> {
  const winner = (f: FieldConflict): 'local' | 'remote' =>
    f.conflict ? (plan.resolutions[f.field] as ConflictChoice) : (f.autoWinner as ConflictChoice);

  const out: Record<string, unknown> = { id: plan.id };
  const nextFieldRev: Record<string, number> = {};
  for (const f of plan.fields) {
    const side = winner(f);
    const src = side === 'local' ? plan.local : plan.remote;
    out[f.field] = src ? src[f.field] : f.remoteValue;
    // 未改动字段保持各侧最高修订号；确有改动（含冲突裁决）的字段在最高版本上 +1，
    // 使合并产物字段修订号严格新于双方，后到的旧值无法回灌
    const touched = f.conflict || f.localChanged || f.remoteChanged;
    nextFieldRev[f.field] = Math.max(f.localRev, f.remoteRev, f.baseRev) + (touched ? 1 : 0);
  }

  const revOf = (row: Record<string, unknown> | null): number =>
    row && typeof row.rev === 'number' ? row.rev : 0;
  const localRev = revOf(plan.local);
  const remoteRev = revOf(plan.remote);
  const baseRev = revOf(plan.base);
  return {
    ...(out as T),
    rev: Math.max(localRev, remoteRev, baseRev) + 1,
    fieldRev: nextFieldRev,
    deviceId: 'merge',
    syncedAt: new Date().toISOString(),
  } as SyncEntity<T>;
}
