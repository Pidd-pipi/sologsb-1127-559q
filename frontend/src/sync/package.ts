import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import type {
  Adjudication,
  AnyEntity,
  FieldConflict,
  MergeCounters,
  MergeOutcome,
  OfflinePackage,
  PackageEntity,
} from '../types/sync';
import { PACKAGE_FORMAT } from '../types/sync';
import { MERGE_FIELDS, entityLabel, inspectionFingerprint, rectifyFingerprint, routeFingerprint } from './fields';
import { mergeEntity, type SyncedEntityShape } from './merge';
import { makeId, toPlain } from '../utils/format';

const DEVICE_KEY = 'gbaccessmap-device-id';

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY) || '';
  if (!id) {
    id = makeId('dev');
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function packEntity<T extends AnyEntity>(entity: T): PackageEntity<T> {
  const sync = entity as unknown as SyncedEntityShape;
  return {
    entity: toPlain(entity),
    base: sync.syncBase ? { ...sync.syncBase } : null,
  };
}

export interface ExportOptions {
  pointIds: string[];
  exportedBy: string;
}

/** 导出选中点位及其核验记录、整改条目、相关路线段 */
export async function exportOfflinePackage(opts: ExportOptions): Promise<OfflinePackage> {
  const pointIdSet = new Set(opts.pointIds);
  const [points, inspections, rectifies, routes] = await Promise.all([
    db.points.filter((p) => pointIdSet.has(p.id)).toArray(),
    db.inspections.filter((i) => pointIdSet.has(i.pointId)).toArray(),
    db.rectifies.filter((r) => pointIdSet.has(r.pointId)).toArray(),
    db.routes.filter((r) => pointIdSet.has(r.fromPointId) || pointIdSet.has(r.toPointId)).toArray(),
  ]);

  const now = new Date().toISOString();
  // 导出时把当前字段值写入基线并随包携带，供回传后三路合并
  const refreshBase = <T extends AnyEntity>(e: T): T => {
    const sync = e as unknown as SyncedEntityShape;
    const base: Record<string, unknown> = {};
    for (const f of MERGE_FIELDS[entityKindOf(e)]) base[f] = (e as unknown as Record<string, unknown>)[f];
    sync.syncBase = base;
    return e;
  };

  points.forEach(refreshBase);
  inspections.forEach(refreshBase);
  rectifies.forEach(refreshBase);
  routes.forEach(refreshBase);

  await db.transaction('rw', db.points, db.inspections, db.rectifies, db.routes, async () => {
    for (const p of points) await db.points.update(p.id, { syncBase: (p as SyncedEntityShape).syncBase });
    for (const i of inspections)
      await db.inspections.update(i.id, { syncBase: (i as SyncedEntityShape).syncBase });
    for (const r of rectifies)
      await db.rectifies.update(r.id, { syncBase: (r as SyncedEntityShape).syncBase });
    for (const r of routes) await db.routes.update(r.id, { syncBase: (r as SyncedEntityShape).syncBase });
  });

  return toPlain({
    format: PACKAGE_FORMAT,
    version: 1,
    packageId: makeId('pkg'),
    exportedAt: now,
    exportedBy: opts.exportedBy,
    deviceId: deviceId(),
    pointIds: opts.pointIds,
    points: points.map(packEntity),
    inspections: inspections.map(packEntity),
    rectifies: rectifies.map(packEntity),
    routes: routes.map(packEntity),
  });
}

export function entityKindOf(e: AnyEntity): keyof typeof MERGE_FIELDS {
  if ('facilityType' in e) return 'point';
  if ('slope' in e) return 'inspection';
  if ('requirement' in e) return 'rectify';
  return 'route';
}

export class PackageValidationError extends Error {}

/** 解析并校验核验包结构（结构错误直接报错，不进收件箱） */
export function parsePackage(text: string): OfflinePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackageValidationError('文件不是合法 JSON，请确认选择的是 .gbapkg 离线核验包');
  }
  const pkg = parsed as Partial<OfflinePackage>;
  if (!parsed || typeof parsed !== 'object') throw new PackageValidationError('核验包内容为空');
  if (pkg.format !== PACKAGE_FORMAT) throw new PackageValidationError('文件格式标识不符，不是本系统的离线核验包');
  if (pkg.version !== 1) throw new PackageValidationError(`不支持的核验包版本：${String(pkg.version)}`);
  if (!pkg.packageId) throw new PackageValidationError('核验包缺少 packageId');
  for (const key of ['points', 'inspections', 'rectifies', 'routes'] as const) {
    if (!Array.isArray(pkg[key])) throw new PackageValidationError(`核验包 ${key} 数据缺失或损坏`);
  }
  return pkg as OfflinePackage;
}

/** 浏览器下载核验包文件 */
export function downloadPackage(pkg: OfflinePackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gbaccessmap-${pkg.packageId}.gbapkg.json`;
  a.click();
  URL.revokeObjectURL(url);
}

interface LocalStore {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  routes: RouteSegment[];
}

/**
 * 预检并在内存中完成合并，不落库：
 * - 点位不足（包内引用点位缺失且本地也没有）→ 整包留待重试，不写任何数据
 * - 同一核验指纹已存在 → 只补一次，重复回传跳过
 * - 存在未裁决字段冲突 → 对应实体不写入 puts，等并排裁决后再合
 */
export function planMerge(local: LocalStore, pkg: OfflinePackage, adjudication: Adjudication): MergeOutcome {
  const counters = (): MergeCounters => ({ added: 0, updated: 0, skipped: 0, conflicted: 0 });
  const out: MergeOutcome['puts'] = { points: [], inspections: [], rectifies: [], routes: [] };
  const result: MergeOutcome = {
    points: counters(),
    inspections: counters(),
    rectifies: counters(),
    routes: counters(),
    puts: out,
    affectedPointIds: [],
    conflicts: [],
    missingPointIds: [],
  };

  // 1. 点位先合：id 优先，其次按点位编号 code 对齐（断网两端各自新建同一编号点位的情况）
  const localByCode = new Map(local.points.map((p) => [p.code, p]));
  const pointAlias = new Map<string, string>();
  const pointCandidates = new Map<string, AccessPoint>();
  const pointConflictIds = new Set<string>();

  for (const item of pkg.points) {
    const remotePoint = item.entity;
    const matched = local.points.find((p) => p.id === remotePoint.id) ?? localByCode.get(remotePoint.code);
    const targetId = matched?.id ?? remotePoint.id;
    pointAlias.set(remotePoint.id, targetId);

    const r = mergeEntity(
      'point',
      matched as SyncedEntityShape | undefined,
      item as PackageEntity<AnyEntity>,
      targetId,
      entityLabel('point', remotePoint),
      adjudication,
    );
    result.conflicts.push(...r.conflicts);
    if (r.conflicts.length) {
      result.points.conflicted += r.conflicts.length;
      pointConflictIds.add(targetId);
    }
    if (matched) r.changed ? result.points.updated++ : result.points.skipped++;
    else result.points.added++;
    pointCandidates.set(targetId, r.merged as AccessPoint);
  }

  // 2. 点位不足检查：核验/整改/路段引用的点位必须在「包内点位或本地点位」中
  const resolvePoint = (id: string): string => pointAlias.get(id) ?? id;
  const available = new Set<string>([...local.points.map((p) => p.id), ...pointCandidates.keys()]);
  const referenced = new Set<string>();
  pkg.inspections.forEach((i) => referenced.add(resolvePoint(i.entity.pointId)));
  pkg.rectifies.forEach((i) => referenced.add(resolvePoint(i.entity.pointId)));
  pkg.routes.forEach((i) => {
    referenced.add(resolvePoint(i.entity.fromPointId));
    referenced.add(resolvePoint(i.entity.toPointId));
  });
  const missing = [...referenced].filter((id) => !available.has(id));
  if (missing.length) {
    result.missingPointIds = missing;
    return result; // 点位不足，整包先不写
  }

  // 未裁决冲突的点位暂不写入
  for (const [id, p] of pointCandidates) {
    if (!pointConflictIds.has(id)) out.points.push(p);
    result.affectedPointIds.push(id); // 点位有新版本即触发路线失效重算（裁决后同样重算）
  }

  type Kind3 = 'inspection' | 'rectify' | 'route';
  const mergeList = (
    kind: Kind3,
    items: PackageEntity<AnyEntity>[],
    localItems: AnyEntity[],
    fingerprint: (e: AnyEntity) => string,
  ): string[] => {
    const bucketName = kind === 'inspection' ? 'inspections' : kind === 'rectify' ? 'rectifies' : 'routes';
    const localFp = new Set(localItems.map(fingerprint));
    const seen = new Set<string>();
    const conflictIds = new Set<string>();
    const candidates: AnyEntity[] = [];
    const affected: string[] = [];

    for (const item of items) {
      const remote = item.entity;
      const fp = fingerprint(remote);
      // 同一核验/整改/路段重复回传：只补一次
      if (localFp.has(fp) || seen.has(fp)) {
        result[bucketName].skipped++;
        continue;
      }
      seen.add(fp);
      const matched = localItems.find((x) => x.id === remote.id);
      const r = mergeEntity(kind, matched as SyncedEntityShape | undefined, item, remote.id, entityLabel(kind, remote), adjudication);
      result.conflicts.push(...r.conflicts);
      if (r.conflicts.length) {
        result[bucketName].conflicted += r.conflicts.length;
        conflictIds.add(remote.id);
      }
      if (matched) r.changed ? result[bucketName].updated++ : result[bucketName].skipped++;
      else result[bucketName].added++;
      candidates.push(r.merged);
      if (kind === 'inspection') affected.push((remote as Inspection).pointId);
    }
    const writable = candidates.filter((e) => !conflictIds.has(e.id));
    if (kind === 'inspection') out.inspections = writable as Inspection[];
    else if (kind === 'rectify') out.rectifies = writable as RectifyPlan[];
    else out.routes = writable as RouteSegment[];
    return affected;
  };

  // 3. 核验记录（先改写引用点位别名再取指纹）
  pkg.inspections.forEach((i) => {
    i.entity.pointId = resolvePoint(i.entity.pointId);
  });
  result.affectedPointIds.push(
    ...mergeList('inspection', pkg.inspections as PackageEntity<AnyEntity>[], local.inspections, (e) =>
      inspectionFingerprint(e as Inspection),
    ),
  );

  // 4. 整改条目：同点位 + 要求 + 期限视为同一条
  pkg.rectifies.forEach((i) => {
    i.entity.pointId = resolvePoint(i.entity.pointId);
  });
  mergeList('rectify', pkg.rectifies as PackageEntity<AnyEntity>[], local.rectifies, (e) =>
    rectifyFingerprint(e as RectifyPlan),
  );

  // 5. 路线段：同名路线同向相邻段视为同一段
  pkg.routes.forEach((i) => {
    i.entity.fromPointId = resolvePoint(i.entity.fromPointId);
    i.entity.toPointId = resolvePoint(i.entity.toPointId);
  });
  mergeList('route', pkg.routes as PackageEntity<AnyEntity>[], local.routes, (e) =>
    routeFingerprint(e as RouteSegment),
  );

  result.affectedPointIds = [...new Set(result.affectedPointIds)];
  return result;
}

/** 冲突是否全部已裁决（每个冲突键都有 local/remote 选择） */
export function unresolvedConflicts(conflicts: FieldConflict[], adjudication: Adjudication): FieldConflict[] {
  return conflicts.filter((c) => adjudication[c.key] !== 'local' && adjudication[c.key] !== 'remote');
}
