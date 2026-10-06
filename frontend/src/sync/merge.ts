import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import type {
  Adjudication,
  AnyEntity,
  EntityKind,
  FieldConflict,
  PackageEntity,
} from '../types/sync';
import { conflictKey } from '../types/sync';
import { FIELD_LABELS, MERGE_FIELDS, sameValue } from './fields';
export type SyncedEntityShape = AnyEntity & {
  rev?: number;
  fieldRevs?: Record<string, number>;
  syncBase?: Record<string, unknown> | null;
  sourcePackageId?: string;
};

type Rec = Record<string, unknown>;

export interface SingleMergeResult {
  merged: AnyEntity;
  changed: boolean;
  conflicts: FieldConflict[];
  /** 合并后的字段是否采用了现场值（用于判断受影响点位与基线刷新） */
  remoteWon: boolean;
}

function asRec(v: unknown): Rec {
  return (v ?? {}) as Rec;
}

/**
 * 逐字段三路合并：
 * - 只有一边相对基线改过 → 采用改过的一边（晚到也不会覆盖早到的修改）
 * - 两边都改过且取值不同 → 冲突并排裁决；未裁决前现场值不写入
 * - 无基线（任一端从未导出过）→ 按逐字段修订号，修订号大的赢；
 *   修订号相同且取值不同 → 冲突，晚到的一份不能覆盖
 */
export function mergeEntity(
  kind: EntityKind,
  local: SyncedEntityShape | undefined,
  incoming: PackageEntity<AnyEntity>,
  id: string,
  label: string,
  adjudication: Adjudication,
): SingleMergeResult {
  const remote = incoming.entity as unknown as SyncedEntityShape;
  const base = (incoming.base ?? undefined) as Rec | undefined;
  const localRec = asRec(local);
  const remoteRec = asRec(remote);
  const fields = MERGE_FIELDS[kind];

  const out: Rec = local ? { ...localRec } : { ...remoteRec, id };
  const fieldRevs: Record<string, number> = {
    ...(((localRec.fieldRevs as Record<string, number> | undefined) ?? {}) as Record<string, number>),
  };
  const conflicts: FieldConflict[] = [];
  let changed = false;
  let remoteWon = false;

  for (const field of fields) {
    const lv = localRec[field];
    const rv = remoteRec[field];
    const bv = base ? base[field] : undefined;
    let next: unknown = local ? lv : rv;

    if (!local) {
      // 新实体：直接采用现场值
      changed = true;
      remoteWon = true;
    } else if (sameValue(lv, rv)) {
      next = lv;
    } else if (base) {
      const localEdited = !sameValue(lv, bv);
      const remoteEdited = !sameValue(rv, bv);
      if (remoteEdited && !localEdited) {
        next = rv;
        changed = true;
        remoteWon = true;
      } else if (localEdited && !remoteEdited) {
        next = lv;
      } else if (localEdited && remoteEdited) {
        next = resolveConflict(conflicts, adjudication, kind, id, label, field, lv, rv, bv, lv);
        if (next === rv) remoteWon = true;
      } else {
        // 两边都没改：晚到的一份不能覆盖
        next = lv;
      }
    } else {
      const lfr = ((localRec.fieldRevs as Record<string, number> | undefined)?.[field] as number) ?? 0;
      const rfr = ((remoteRec.fieldRevs as Record<string, number> | undefined)?.[field] as number) ?? 0;
      if (rfr > lfr) {
        next = rv;
        changed = true;
        remoteWon = true;
      } else if (rfr < lfr) {
        next = lv;
      } else {
        // 同修订号、两边不同 → 并排裁决
        next = resolveConflict(conflicts, adjudication, kind, id, label, field, lv, rv, undefined, lv);
        if (next === rv) remoteWon = true;
      }
    }

    out[field] = next;
    if (!local) {
      fieldRevs[field] = (remoteRec.fieldRevs as Record<string, number> | undefined)?.[field] ?? 0;
      continue;
    }
    if (local && !sameValue(next, lv)) changed = true;
    // 任一侧相对基线改过（无基线时任一侧带字段修订号），字段修订号即推进
    const touchedBase = base ? !sameValue(lv, bv) || !sameValue(rv, bv) : false;
    const touchedNoBase =
      !base &&
      (((localRec.fieldRevs as Record<string, number> | undefined)?.[field] ?? 0) > 0 ||
        ((remoteRec.fieldRevs as Record<string, number> | undefined)?.[field] ?? 0) > 0);
    if (touchedBase || touchedNoBase) {
      fieldRevs[field] =
        Math.max(
          (localRec.fieldRevs as Record<string, number> | undefined)?.[field] ?? 0,
          (remoteRec.fieldRevs as Record<string, number> | undefined)?.[field] ?? 0,
        ) + 1;
    }
  }

  if (!local) {
    out.rev = (remoteRec.rev as number | undefined) ?? 1;
  } else {
    const localRev = (localRec.rev as number | undefined) ?? 1;
    const remoteRev = (remoteRec.rev as number | undefined) ?? 1;
    // 晚到包修订号不会反向覆盖：本机值发生变化才推进
    out.rev = changed ? Math.max(localRev, remoteRev) + 1 : Math.max(localRev, remoteRev);
  }
  out.fieldRevs = fieldRevs;
  // 本次合并基线随实体保存，作为下次三路合并的共同基线
  out.syncBase = base ? { ...base } : ((localRec.syncBase as Record<string, unknown> | null | undefined) ?? null);
  out.sourcePackageId = remoteRec.sourcePackageId;
  out.id = id;

  return { merged: out as unknown as AnyEntity, changed, conflicts, remoteWon };
}

function resolveConflict(
  conflicts: FieldConflict[],
  adjudication: Adjudication,
  kind: EntityKind,
  id: string,
  label: string,
  field: string,
  lv: unknown,
  rv: unknown,
  bv: unknown,
  fallback: unknown,
): unknown {
  const key = conflictKey(kind, id, field);
  if (!conflicts.some((c) => c.key === key)) {
    conflicts.push({
      key,
      kind,
      entityId: id,
      entityLabel: label,
      field,
      fieldLabel: FIELD_LABELS[kind][field] ?? field,
      localValue: lv,
      remoteValue: rv,
      baseValue: bv,
    });
  }
  const choice = adjudication[key];
  if (choice === 'remote') return rv;
  if (choice === 'local') return lv;
  // 未裁决：默认保留本机值，现场包不覆盖
  return fallback;
}

/** 合并后把「合并值」写回基线，作为下次导出/合并的共同基线 */
export function snapshotBase(kind: EntityKind, merged: AnyEntity): Record<string, unknown> {
  const rec = merged as unknown as Rec;
  const snap: Record<string, unknown> = {};
  for (const f of MERGE_FIELDS[kind]) snap[f] = rec[f];
  return snap;
}

export function isInspection(v: AnyEntity): v is Inspection {
  return 'pointId' in v && 'slope' in v;
}

export function isRectify(v: AnyEntity): v is RectifyPlan {
  return 'requirement' in v && 'deadline' in v;
}

export function isRoute(v: AnyEntity): v is RouteSegment {
  return 'fromPointId' in v && 'toPointId' in v;
}
