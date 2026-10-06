import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type {
  AppliedOp,
  ApplyResult,
  ConflictChoice,
  EntityMergePlan,
  MergePreview,
  OfflinePackage,
  PackagePayload,
  PackageRecord,
  SyncEntity,
} from '../types/sync';
import {
  buildMergePreview,
  preflight,
  referencedPointIds,
  resolveEntity,
} from './merge';
import { getDeviceId, inspectionFingerprint, makePackageId } from './revision';
import { affectedSegments, deriveSegmentState, type SegmentContext } from '../utils/routeLive';

/** 导出选中点位及相关核验记录、整改条目（含路线引用，供现场端参考） */
export async function exportPackage(pointIds: string[], note?: string): Promise<OfflinePackage> {
  const idSet = new Set(pointIds);
  const points = await db.points.where('id').anyOf(pointIds).toArray();
  const foundIds = new Set(points.map((p) => p.id));
  const missing = pointIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw new Error(`选中点位中有 ${missing.length} 个不存在，无法导出：${missing.slice(0, 3).join('、')}`);
  }
  const inspections = await db.inspections.filter((i) => idSet.has(i.pointId)).toArray();
  const rectifies = await db.rectifies.filter((r) => idSet.has(r.pointId)).toArray();

  const payload: PackagePayload = { points, inspections, rectifies };
  const now = new Date().toISOString();
  const pkg: OfflinePackage = {
    format: 'gbaccessmap-offline',
    packageVersion: 1,
    kind: 'export',
    packageId: makePackageId('exp'),
    exportId: '',
    deviceId: getDeviceId(),
    createdAt: now,
    pointIds,
    // 基线 = 当前快照；导出包 entities 与 base 相同
    base: structuredCloneSafe(payload),
    entities: payload,
    note,
  };
  pkg.exportId = pkg.packageId;
  return pkg;
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 现场端在断网编辑后，把下发包封成回传包（实际项目由现场设备执行，这里提供同构实现） */
export function sealReturnPackage(
  exportPkg: OfflinePackage,
  edited: PackagePayload,
  deviceId = getDeviceId(),
  note?: string,
): OfflinePackage {
  return {
    ...exportPkg,
    kind: 'return',
    packageId: makePackageId('ret'),
    exportId: exportPkg.exportId || exportPkg.packageId,
    deviceId,
    returnedAt: new Date().toISOString(),
    base: structuredCloneSafe(exportPkg.base),
    entities: structuredCloneSafe(edited),
    note: note ?? exportPkg.note,
  };
}

/** 解析上传文件为离线包并做格式校验 */
export function parsePackage(text: string): OfflinePackage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  const pkg = data as Partial<OfflinePackage>;
  if (!pkg || pkg.format !== 'gbaccessmap-offline') {
    throw new Error('不是 gbaccessmap 离线核验包（format 不匹配）');
  }
  if (pkg.packageVersion !== 1) {
    throw new Error(`不支持的离线包版本：${String(pkg.packageVersion)}`);
  }
  if (!pkg.packageId || !pkg.base || !pkg.entities) {
    throw new Error('离线包缺少 packageId / base / entities，文件可能已损坏');
  }
  return pkg as OfflinePackage;
}

async function loadSeenFingerprints(): Promise<Set<string>> {
  const rows = await db.seenInspections.toCollection().primaryKeys();
  return new Set(rows);
}

export interface IntakeResult {
  /** already-applied：同一回传重复导入，幂等跳过；staged：已留待重试；preview：待裁决 */
  outcome: 'applied-before' | 'staged' | 'preview';
  record: PackageRecord;
  preflightErrors: string[];
  preflightWarnings: string[];
  preview: MergePreview | null;
  conflictCount: number;
}

/**
 * 导入入口：
 * 1) 同一 packageId 已应用 → 幂等跳过（整包只生效一次）；
 * 2) 预检失败（点位不足等）→ 整包落 stagedPackages，状态 pending，不写任何业务数据；
 * 3) 预检通过但存在未裁决冲突 → 整包暂存 status=conflict，等待并排裁决；
 * 4) 预检通过且无冲突 → 整包暂存 status=pending，由用户确认后一键应用。
 */
export async function intakePackage(pkg: OfflinePackage, fileName: string): Promise<IntakeResult> {
  // 幂等：同包重复导入
  const existed = await db.stagedPackages.get(pkg.packageId);
  if (existed && existed.status === 'applied') {
    return {
      outcome: 'applied-before',
      record: existed,
      preflightErrors: [],
      preflightWarnings: ['该回传包此前已应用，本次为重复回传，整包跳过未重复写入'],
      preview: null,
      conflictCount: 0,
    };
  }

  const local = {
    points: await db.points.toArray(),
    inspections: await db.inspections.toArray(),
    rectifies: await db.rectifies.toArray(),
  };
  const seen = await loadSeenFingerprints();
  const check = preflight(pkg, { points: local.points }, seen, inspectionFingerprint);

  const now = new Date().toISOString();
  const record: PackageRecord = {
    id: pkg.packageId,
    exportId: pkg.exportId || pkg.packageId,
    deviceId: pkg.deviceId,
    kind: pkg.kind,
    status: check.ok ? 'pending' : 'failed',
    fileName,
    payload: pkg,
    resolutions: {},
    note: pkg.note,
    error: check.ok ? '' : check.errors.join('；'),
    createdAt: existed?.createdAt ?? now,
    updatedAt: now,
  };

  let preview: MergePreview | null = null;
  let outcome: IntakeResult['outcome'] = 'staged';

  if (check.ok) {
    preview = buildMergePreview(pkg, local, seen, inspectionFingerprint);
    if (preview.conflictCount > 0) {
      record.status = 'conflict';
    }
    outcome = 'preview';
  }

  // 整包先原样留档（导入中断时可从此整包重试），upsert 保留 createdAt
  await db.stagedPackages.put(record);

  return {
    outcome,
    record,
    preflightErrors: check.errors,
    preflightWarnings: check.warnings,
    preview,
    conflictCount: preview?.conflictCount ?? 0,
  };
}

/** 从暂存区重建合并预览（中断重试 / 继续裁决时使用） */
export async function previewStaged(recordId: string): Promise<MergePreview | null> {
  const rec = await db.stagedPackages.get(recordId);
  if (!rec) return null;
  const seen = await loadSeenFingerprints();
  const preview = buildMergePreview(
    rec.payload,
    {
      points: await db.points.toArray(),
      inspections: await db.inspections.toArray(),
      rectifies: await db.rectifies.toArray(),
    },
    seen,
    inspectionFingerprint,
  );
  // 回填此前已做的裁决
  for (const plan of preview.plans) {
    const saved = rec.resolutions[plan.id];
    if (saved) plan.resolutions = { ...saved };
  }
  return preview;
}

/** 持久化裁决结果到暂存包（冲突未裁完也能先存，留待下次继续） */
export async function saveResolutions(
  recordId: string,
  resolutions: Record<string, Record<string, ConflictChoice>>,
): Promise<void> {
  const rec = await db.stagedPackages.get(recordId);
  if (!rec) return;
  await db.stagedPackages.update(recordId, {
    resolutions,
    updatedAt: new Date().toISOString(),
  });
}

export async function listStaged(): Promise<PackageRecord[]> {
  const rows = await db.stagedPackages.orderBy('createdAt').reverse().toArray();
  return rows;
}

export async function removeStaged(id: string): Promise<void> {
  await db.stagedPackages.delete(id);
}

function opKey(kind: EntityMergePlan['kind'], entityId: string): string {
  return `${kind}:${entityId}`;
}

/** 剥离同步元数据，只保留业务字段 */
function stripSync<T>(row: SyncEntity<T>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
  delete out.rev;
  delete out.fieldRev;
  delete out.deviceId;
  delete out.syncedAt;
  return out;
}

/**
 * 应用一个已通过预检、冲突已裁决的暂存包。
 * 单一大事务保证原子性：
 * - appliedOps 去重 → 中断重试时同一操作不会二次生效；
 * - 核验按业务指纹去重 → 同一核验重复回传只补一次；
 * - 点位不足预检已在 intake 阶段拦截，此处再做一次硬校验，不满足则整包抛错不写；
 * - 写完后立即重算受影响路段，旧全线结论不再展示。
 */
export async function applyStaged(
  recordId: string,
  resolutions: Record<string, Record<string, ConflictChoice>>,
): Promise<ApplyResult> {
  const rec = await db.stagedPackages.get(recordId);
  if (!rec) throw new Error('暂存包不存在，无法应用');
  if (rec.status === 'applied') {
    throw new Error('该包已应用，请勿重复应用；重复回传应在导入时自动跳过');
  }

  return db.transaction(
    'rw',
    [
      db.stagedPackages,
      db.points,
      db.inspections,
      db.rectifies,
      db.routes,
      db.appliedOps,
      db.seenInspections,
    ],
    async () => {
      const pkg = rec.payload;
      const local = {
        points: await db.points.toArray(),
        inspections: await db.inspections.toArray(),
        rectifies: await db.rectifies.toArray(),
      };
      const seen = new Set(await db.seenInspections.toCollection().primaryKeys());

      // 硬校验点位完整性：点位不足先不写
      const localPointIds = new Set(local.points.map((p) => p.id));
      const remotePointIds = new Set(pkg.entities.points.map((p) => p.id));
      const missing: string[] = [];
      for (const pid of referencedPointIds(pkg)) {
        if (!localPointIds.has(pid) && !remotePointIds.has(pid)) missing.push(pid);
      }
      if (missing.length) {
        await db.stagedPackages.update(recordId, {
          status: 'failed',
          error: `点位不足，整包未写入：${missing.slice(0, 5).join('、')}`,
          updatedAt: new Date().toISOString(),
        });
        throw new Error(`点位不足（${missing.length} 个），整包未写入，已留待重试`);
      }

      const preview = buildMergePreview(pkg, local, seen, inspectionFingerprint);
      for (const plan of preview.plans) {
        const saved = resolutions[plan.id] ?? rec.resolutions[plan.id];
        if (saved) plan.resolutions = { ...saved };
      }
      const unresolved = preview.plans.flatMap((p) =>
        p.fields.filter((f) => f.conflict && !p.resolutions[f.field]).map((f) => `${p.id}.${f.field}`),
      );
      if (unresolved.length) {
        await db.stagedPackages.update(recordId, { status: 'conflict', updatedAt: new Date().toISOString() });
        throw new Error(`仍有 ${unresolved.length} 个冲突字段未裁决，请先并排裁决`);
      }

      await db.stagedPackages.update(recordId, {
        status: 'applying',
        resolutions,
        updatedAt: new Date().toISOString(),
      });

      const now = new Date().toISOString();
      const applied = { points: 0, inspections: 0, rectifies: 0 };
      const touchedPointIds = new Set<string>();
      let skippedDup = 0;

      const ensureOp = async (kind: EntityMergePlan['kind'], entityId: string): Promise<boolean> => {
        const id = `${pkg.packageId}:${opKey(kind, entityId)}`;
        const hit = await db.appliedOps.get(id);
        if (hit) return false;
        await db.appliedOps.put({
          id,
          packageId: pkg.packageId,
          opKey: opKey(kind, entityId),
          entityKind: kind,
          entityId,
          appliedAt: now,
        } satisfies AppliedOp);
        return true;
      };

      /**
       * 实体是否需要落库：
       * 出现过字段冲突时，无论最终取值是否等于本地，都落一个合并版本（抬 rev），
       * 记录裁决结果；否则仅在确有字段差异时写入。
       */
      const needsWrite = (plan: EntityMergePlan, business: Record<string, unknown>): boolean => {
        if (plan.fields.some((f) => f.conflict)) return true;
        if (!plan.local) return true; // 新建
        return plan.businessFields.some((f) => {
          const a = (plan.local as Record<string, unknown>)[f];
          const b = business[f];
          if (a === b) return false;
          if (typeof a === 'number' || typeof b === 'number') {
            if (a === '' || b === '') return a !== b;
            return Number(a) !== Number(b);
          }
          return JSON.stringify(a) !== JSON.stringify(b);
        });
      };

      // 先点位，后核验/整改（引用完整性）
      for (const plan of preview.plans.filter((p) => p.kind === 'point' && p.remote)) {
        const merged = resolveEntity<Omit<AccessPoint, 'rev' | 'fieldRev' | 'deviceId' | 'syncedAt'>>(
          plan,
        );
        const business = stripSync(merged);
        const write = needsWrite(plan, business);
        if (!(await ensureOp('point', plan.id))) {
          applied.points += 1;
          // 已应用过的点位视为已落地，相关路线仍应纳入重算
          touchedPointIds.add(plan.id);
          continue;
        }
        if (!write) {
          // 现场未改该点位：不重写、不自增修订号、不触发路线失效
          continue;
        }
        // 直接采用合并产物的权威修订号（冲突字段已在 resolveEntity 抬高），刷新 updatedAt
        const stamped = {
          ...business,
          updatedAt: now,
          rev: merged.rev,
          fieldRev: { ...merged.fieldRev, updatedAt: merged.rev },
          deviceId: merged.deviceId,
          syncedAt: now,
        } as unknown as SyncEntity<AccessPoint>;
        await db.points.put(stamped);
        // 点位确有变化：相关路线段立即失效重算
        touchedPointIds.add(plan.id);
        applied.points += 1;
      }

      // 应用后的点位表（供整改/核验收尾与路线重算）
      const pointsAfter = await db.points.toArray();
      const pointIdAfter = new Set(pointsAfter.map((p) => p.id));

      for (const plan of preview.plans.filter((p) => p.kind === 'inspection' && p.remote)) {
        const remote = plan.remote as unknown as SyncEntity<Inspection>;
        // 指纹去重：同一核验重复回传只补一次
        const fp = inspectionFingerprint(remote);
        if (seen.has(fp)) {
          skippedDup += 1;
          continue;
        }
        // 远程引用的点位必须已就位（预检+点位先行已保证）
        if (!pointIdAfter.has(remote.pointId)) {
          throw new Error(`核验 ${plan.id} 所属点位 ${remote.pointId} 缺失，整包回滚`);
        }
        const merged = resolveEntity<Omit<Inspection, 'rev' | 'fieldRev' | 'deviceId' | 'syncedAt'>>(plan);
        const business = stripSync(merged);
        const write = needsWrite(plan, business);
        const isNewOp = await ensureOp('inspection', plan.id);
        if (!isNewOp) {
          applied.inspections += 1;
          seen.add(fp);
          touchedPointIds.add(remote.pointId);
          continue;
        }
        if (!write) {
          // 内容与本地一致但此前未见指纹：登记指纹后跳过写入（只补一次）
          seen.add(fp);
          await db.seenInspections.put({
            id: fp,
            pointId: remote.pointId,
            date: remote.date,
            inspector: remote.inspector,
            inspectionId: plan.id,
            packageId: pkg.packageId,
            seenAt: now,
          });
          continue;
        }
        const stamped = {
          ...business,
          rev: merged.rev,
          fieldRev: { ...merged.fieldRev },
          deviceId: merged.deviceId,
          syncedAt: now,
        } as unknown as SyncEntity<Inspection>;
        await db.inspections.put(stamped);
        applied.inspections += 1;
        seen.add(fp);
        await db.seenInspections.put({
          id: fp,
          pointId: remote.pointId,
          date: remote.date,
          inspector: remote.inspector,
          inspectionId: stamped.id,
          packageId: pkg.packageId,
          seenAt: now,
        });
        // 最新核验结论可能变化 → 相关路段立即失效
        touchedPointIds.add(remote.pointId);
      }

      for (const plan of preview.plans.filter((p) => p.kind === 'rectify' && p.remote)) {
        const remote = plan.remote as unknown as SyncEntity<RectifyPlan>;
        if (!pointIdAfter.has(remote.pointId)) {
          throw new Error(`整改条目 ${plan.id} 所属点位 ${remote.pointId} 缺失，整包回滚`);
        }
        const merged = resolveEntity<Omit<RectifyPlan, 'rev' | 'fieldRev' | 'deviceId' | 'syncedAt'>>(plan);
        const business = stripSync(merged);
        if (!(await ensureOp('rectify', plan.id))) {
          applied.rectifies += 1;
          continue;
        }
        if (!needsWrite(plan, business)) {
          // 现场未改该整改条目：不重写、不自增修订号
          continue;
        }
        const stamped = {
          ...business,
          rev: merged.rev,
          fieldRev: { ...merged.fieldRev },
          deviceId: merged.deviceId,
          syncedAt: now,
        } as unknown as SyncEntity<RectifyPlan>;
        await db.rectifies.put(stamped);
        applied.rectifies += 1;
      }

      // 立即失效重算相关路线段：用最新点位+最新核验派生，回写审计状态
      const allSegments = await db.routes.toArray();
      const impacted = affectedSegments(allSegments, touchedPointIds);
      const ctx: SegmentContext = { points: pointsAfter, inspections: await db.inspections.toArray() };
      const invalidatedSegmentIds: string[] = [];
      for (const seg of impacted) {
        const state = deriveSegmentState(seg, ctx);
        if (state.state === 'invalid') {
          invalidatedSegmentIds.push(seg.id);
        }
        await db.routes.put({
          ...seg,
          length: Math.round(state.derivedLength * 10) / 10,
          validState: state.state,
          invalidReason: state.state === 'invalid' ? state.reasons.join('；') : '',
        });
      }

      const result: ApplyResult = {
        packageId: pkg.packageId,
        applied,
        skippedDuplicateInspections: skippedDup,
        invalidatedSegmentIds,
      };

      await db.stagedPackages.update(recordId, {
        status: 'applied',
        error: '',
        appliedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return result;
    },
  );
}

/** 重试整包：预检通过且无未裁决冲突即可直接再次应用（appliedOps 保证不重复生效） */
export async function retryStaged(recordId: string): Promise<ApplyResult> {
  const rec = await db.stagedPackages.get(recordId);
  if (!rec) throw new Error('暂存包不存在');
  return applyStaged(recordId, rec.resolutions);
}

/** 下载 JSON 文件（浏览器侧） */
export function downloadJson(pkg: OfflinePackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = pkg.kind === 'return' ? pkg.returnedAt ?? pkg.createdAt : pkg.createdAt;
  a.href = url;
  a.download = `offline-${pkg.kind}-${stamp.slice(0, 10)}-${pkg.packageId.slice(-6)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
