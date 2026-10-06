import type { Inspection } from '../types/inspection';
import type { FieldRevMap, SyncEntity } from '../types/sync';

/**
 * 核验业务指纹：同一核验重复回传只补一次。
 * 以点位 + 核验日期 + 核验人 + 关键实测值 + 结论作为业务身份，
 * 与记录 id / 设备无关——现场端重复导出回传同一批核验时指纹稳定。
 */
export function inspectionFingerprint(ins: Inspection): string {
  const parts = [
    ins.pointId,
    ins.date || '',
    (ins.inspector || '').trim(),
    Number(ins.slope) || 0,
    Number(ins.clearWidth) || 0,
    ins.hasHandrail ? 1 : 0,
    ins.tactileContinuous ? 1 : 0,
    ins.occupied || '',
    ins.conclusion || '',
    (ins.problem || '').trim(),
  ];
  return `fp|${parts.join('|')}`;
}

/** 现场设备标识：持久化在 localStorage，一次浏览器长期固定 */
const DEVICE_KEY = 'gbaccessmap-device-id';

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // localStorage 不可用时退化为会话内随机标识
    return `dev-session-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 生成包 id */
export function makePackageId(prefix: 'exp' | 'ret'): string {
  return `pkg-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 给一个无同步元数据的实体补初始修订信息（v4 迁移 / 老数据兼容）。
 * rev 从 1 起，所有既有字段 fieldRev=1。
 */
export function withInitialSync<T extends { id: string }>(
  row: T,
  deviceId: string,
  at: string,
  extraFields: string[] = [],
): SyncEntity<T> {
  const meta = row as Record<string, unknown>;
  if (typeof meta.rev === 'number' && meta.fieldRev) return row as SyncEntity<T>;
  const fieldRev: FieldRevMap = {};
  for (const key of Object.keys(row)) {
    if (key !== 'id') fieldRev[key] = 1;
  }
  for (const key of extraFields) fieldRev[key] ??= 1;
  return { ...row, rev: 1, fieldRev, deviceId, syncedAt: at } as SyncEntity<T>;
}

/**
 * 实体写入前打补丁：逐字段比较新旧值，改动的字段 fieldRev 提升到新 rev，
 * 未改动字段保持原修订号。新插入的实体 rev=1。
 * 内部以宽松记录承载，调用处收窄到具体实体类型。
 */
export function bumpRevision(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  deviceId: string,
  at: string,
  syncFields: string[],
): Record<string, unknown> {
  const fieldRev: FieldRevMap = {};
  if (!prev) {
    for (const f of [...Object.keys(next), ...syncFields]) {
      if (f !== 'id') fieldRev[f] = 1;
    }
    return { ...next, rev: 1, fieldRev, deviceId, syncedAt: at };
  }
  const rev = (typeof prev.rev === 'number' ? prev.rev : 1) + 1;
  const prevFieldRev = prev.fieldRev as FieldRevMap | undefined;
  const fields = new Set([...Object.keys(prev), ...Object.keys(next), ...syncFields]);
  fields.delete('id');
  for (const f of fields) {
    const oldV = prev[f];
    const newV = next[f];
    const changed =
      newV !== undefined && (oldV === undefined || JSON.stringify(oldV) !== JSON.stringify(newV));
    fieldRev[f] = changed ? rev : prevFieldRev?.[f] ?? (typeof prev.rev === 'number' ? prev.rev : 1);
  }
  return { ...next, rev, fieldRev, deviceId, syncedAt: at };
}
