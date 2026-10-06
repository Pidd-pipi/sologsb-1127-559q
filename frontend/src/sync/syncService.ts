import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import type {
  Adjudication,
  InboundPackage,
  MergeOutcome,
  OfflinePackage,
  SyncLedgerEntry,
} from '../types/sync';
import { MERGE_FIELDS } from './fields';
import type { SyncedEntityShape } from './merge';
import { parsePackage, planMerge, PackageValidationError } from './package';
import { recalcSegments } from '../utils/routeCheck';
import { makeId, toPlain } from '../utils/format';

async function readLocalData() {
  const [points, inspections, rectifies, routes] = await Promise.all([
    db.points.toArray(),
    db.inspections.toArray(),
    db.rectifies.toArray(),
    db.routes.toArray(),
  ]);
  return { points, inspections, rectifies, routes };
}

// 重新导出，页面层只依赖 service
export { parsePackage, PackageValidationError };

export async function listInbound(): Promise<InboundPackage[]> {
  return db.inbound.orderBy('updatedAt').reverse().toArray();
}

/** 内存预检（不落库）：结构错误抛出；点位不足/冲突返回结果供 UI 处理 */
export async function previewPackage(
  pkg: OfflinePackage,
  adjudication: Adjudication = {},
): Promise<MergeOutcome> {
  const local = await readLocalData();
  return planMerge(local, pkg, adjudication);
}

/** 收件箱登记：待重试 / 待裁决 */
export async function enqueueInbound(
  pkg: OfflinePackage,
  status: InboundPackage['status'],
  error = '',
): Promise<void> {
  const now = new Date().toISOString();
  const existed = await db.inbound.get(pkg.packageId);
  await db.inbound.put(
    toPlain({
      id: pkg.packageId,
      status,
      payload: pkg,
      error,
      attempts: (existed?.attempts ?? 0) + 1,
      createdAt: existed?.createdAt ?? now,
      updatedAt: now,
    }),
  );
}

function syncBases(
  points: AccessPoint[],
  inspections: Inspection[],
  rectifies: RectifyPlan[],
  routes: RouteSegment[],
): void {
  const stamp = <T extends { id: string }>(rows: T[], kind: keyof typeof MERGE_FIELDS) => {
    for (const row of rows) {
      const sync = row as unknown as SyncedEntityShape;
      const base: Record<string, unknown> = {};
      for (const f of MERGE_FIELDS[kind]) base[f] = (row as Record<string, unknown>)[f];
      sync.syncBase = base;
    }
  };
  stamp(points, 'point');
  stamp(inspections, 'inspection');
  stamp(rectifies, 'rectify');
  stamp(routes, 'route');
}

/**
 * 原子应用合并：
 * 全部业务表 + inbound + ledger 在同一个 Dexie 事务里提交；
 * 事务中断（含任何异常）时整包留待重试，不产生半批写入。
 */
export async function applyPackage(pkg: OfflinePackage, adjudication: Adjudication = {}): Promise<MergeOutcome> {
  const local = await readLocalData();
  const planned = planMerge(local, pkg, adjudication);
  if (planned.missingPointIds.length) {
    await enqueueInbound(
      pkg,
      '待重试',
      `点位不足，缺少 ${planned.missingPointIds.join('、')}，先不写入`,
    );
    return planned;
  }
  const unresolved = planned.conflicts.filter(
    (c) => adjudication[c.key] !== 'local' && adjudication[c.key] !== 'remote',
  );
  if (unresolved.length) {
    await enqueueInbound(pkg, '待裁决', `${unresolved.length} 个字段冲突等待并排裁决`);
    return planned;
  }

  // 台账幂等：同一核验包只应用一次
  if (await db.ledger.get(pkg.packageId)) {
    return planned;
  }

  try {
    await db.transaction(
      'rw',
      // 多表事务必须用数组形式（Dexie 重载限制）
      [db.points, db.inspections, db.routes, db.rectifies, db.inbound, db.ledger],
      async () => {
        const { puts, affectedPointIds } = planned;
        syncBases(puts.points, puts.inspections, puts.rectifies, puts.routes);

        if (puts.points.length) await db.points.bulkPut(toPlain(puts.points));
        if (puts.inspections.length) await db.inspections.bulkPut(toPlain(puts.inspections));
        if (puts.rectifies.length) await db.rectifies.bulkPut(toPlain(puts.rectifies));
        if (puts.routes.length) await db.routes.bulkPut(toPlain(puts.routes));

        // 最新核验结论或点位变化后，相关路线段立即失效并重算
        await invalidateAndRebuild(new Set(affectedPointIds));

        const now = new Date().toISOString();
        const entry: SyncLedgerEntry = {
          id: pkg.packageId,
          appliedAt: now,
          exportedBy: pkg.exportedBy,
          pointCount: planned.points.added + planned.points.updated,
          inspectionCount: planned.inspections.added + planned.inspections.updated,
          rectifyCount: planned.rectifies.added + planned.rectifies.updated,
          routeCount: planned.routes.added + planned.routes.updated,
        };
        await db.ledger.put(toPlain(entry));
        await db.inbound.put(
          toPlain({
            id: pkg.packageId,
            status: '已应用' as const,
            payload: pkg,
            error: '',
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      },
    );
  } catch (e) {
    // 事务已整体回滚：整包留待重试，点位不足先不写同样适用
    await enqueueInbound(
      pkg,
      '待重试',
      `导入中断：${e instanceof Error ? e.message : String(e)}，整包留待重试`,
    );
    throw e;
  }

  return planned;
}

/**
 * 使受影响点位相关路线段失效并重算：
 * 端点点位或最新核验结论变化 → 关联段 state=失效 立即落库，随后重算。
 */
export async function invalidateAndRebuild(affectedPointIds: Set<string>): Promise<number> {
  if (!affectedPointIds.size) return 0;
  const [points, inspections, routes] = await Promise.all([
    db.points.toArray(),
    db.inspections.toArray(),
    db.routes.toArray(),
  ]);

  const touched = routes.filter(
    (s) => affectedPointIds.has(s.fromPointId) || affectedPointIds.has(s.toPointId),
  );
  if (!touched.length) return 0;

  const now = new Date().toISOString();
  const recalced = recalcSegments(touched, points, inspections);
  const recalcMap = new Map(recalced.map((r) => [r.id, r]));

  for (const seg of touched) {
    const r = recalcMap.get(seg.id);
    if (!r) continue;
    const changedState = r.state !== seg.state;
    const changedPass = r.wheelchairPassable !== seg.wheelchairPassable;
    if (changedState || changedPass || r.gateNote) {
      await db.routes.update(seg.id, {
        state: r.state,
        stateReason: r.state === '失效' ? r.stateReason : '',
        wheelchairPassable: r.wheelchairPassable,
        rebuiltAt: now,
      });
    }
  }
  return touched.length;
}

/** 待重试 / 待裁决整包重试 */
export async function retryInbound(id: string, adjudication: Adjudication = {}): Promise<MergeOutcome | null> {
  const inbound = await db.inbound.get(id);
  if (!inbound) return null;
  return applyPackage(inbound.payload, adjudication);
}

export async function ignoreInbound(id: string): Promise<void> {
  await db.inbound.update(id, { status: '已忽略', updatedAt: new Date().toISOString() });
}

/** 已应用记录（幂等台账） */
export async function listLedger(): Promise<SyncLedgerEntry[]> {
  return db.ledger.orderBy('appliedAt').reverse().toArray();
}

export { makeId };
