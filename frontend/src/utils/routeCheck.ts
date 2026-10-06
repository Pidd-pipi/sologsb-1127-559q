import type { AccessPoint } from '../types/point';
import type { Inspection, InspectionConclusion, OccupiedLevel } from '../types/inspection';
import type { RouteSegment, RouteVerdict } from '../types/route';

/** 阈值常量：依据《无障碍设计规范》常用核验口径 */
export const SLOPE_PASS = 5; // 坡度 ≤ 5% 为合格
export const SLOPE_FAIL = 8; // 坡度 > 8% 直接不合格
export const WIDTH_PASS = 120; // 净宽 ≥ 120cm 为合格
export const WIDTH_MIN = 90; // 净宽 < 90cm 不合格
export const CURB_PASS = 3; // 路缘高差 ≤ 3cm 可轮椅通行
export const CURB_FAIL = 6; // 路缘高差 > 6cm 判定不可通行

export interface JudgeInput {
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
}

export interface JudgeResult {
  conclusion: InspectionConclusion;
  reasons: string[];
}

/** 按实测值给出结论建议 */
export function judgeInspection(input: JudgeInput): JudgeResult {
  const reasons: string[] = [];
  const slope = Number(input.slope) || 0;
  const clearWidth = Number(input.clearWidth) || 0;

  if (slope > SLOPE_FAIL) reasons.push(`坡度 ${slope}% 超过 ${SLOPE_FAIL}% 上限`);
  if (clearWidth < WIDTH_MIN) reasons.push(`净宽 ${clearWidth}cm 小于 ${WIDTH_MIN}cm 下限`);
  if (input.occupied === '长期占用') reasons.push('设施被长期占用，无法正常使用');
  if (reasons.length) return { conclusion: '不合格', reasons };

  const warns: string[] = [];
  if (slope > SLOPE_PASS) warns.push(`坡度 ${slope}% 超过 ${SLOPE_PASS}% 推荐值`);
  if (clearWidth < WIDTH_PASS) warns.push(`净宽 ${clearWidth}cm 小于 ${WIDTH_PASS}cm 推荐值`);
  if (!input.hasHandrail) warns.push('未设置扶手');
  if (!input.tactileContinuous) warns.push('盲道不连续');
  if (input.occupied === '临时占用') warns.push('设施被临时占用');
  if (warns.length) return { conclusion: '限期整改', reasons: warns };

  return { conclusion: '合格', reasons: ['坡度、净宽均满足推荐值，扶手与盲道完好'] };
}

/** 已落库的核验记录（可能带有历史结论）复判 */
export function rejudge(inspection: Inspection): JudgeResult {
  return judgeInspection({
    slope: inspection.slope,
    clearWidth: inspection.clearWidth,
    hasHandrail: inspection.hasHandrail,
    tactileContinuous: inspection.tactileContinuous,
    occupied: inspection.occupied,
  });
}

/** 单段可轮椅通行判定 */
export function judgeSegment(seg: Pick<RouteSegment, 'curbHeight' | 'stepCount' | 'obstacleCount'>): {
  passable: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const curb = Number(seg.curbHeight) || 0;
  const steps = Number(seg.stepCount) || 0;
  const obstacles = Number(seg.obstacleCount) || 0;
  if (curb > CURB_FAIL) reasons.push(`路缘高差 ${curb}cm 超过 ${CURB_FAIL}cm，轮椅无法越障`);
  if (steps > 0) reasons.push(`存在 ${steps} 级台阶，需绕行或增设坡道`);
  if (obstacles > 2) reasons.push(`沿途障碍 ${obstacles} 处，通行风险偏高`);
  return { passable: reasons.length === 0, reasons };
}

/** 全线判定：逐段判定后汇总 */
export function buildVerdict(
  routeName: string,
  segments: Pick<
    RouteSegment,
    'curbHeight' | 'stepCount' | 'obstacleCount' | 'length' | 'order' | 'fromPointId' | 'toPointId'
  >[],
): RouteVerdict {
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  const totalLength = Math.round(ordered.reduce((n, s) => n + (Number(s.length) || 0), 0) * 10) / 10;
  const totalObstacles = ordered.reduce((n, s) => n + (Number(s.obstacleCount) || 0), 0);
  const totalSteps = ordered.reduce((n, s) => n + (Number(s.stepCount) || 0), 0);
  const maxCurbHeight = ordered.reduce((n, s) => Math.max(n, Number(s.curbHeight) || 0), 0);
  const reasons: string[] = [];
  ordered.forEach((s) => {
    const r = judgeSegment(s);
    if (!r.passable) {
      reasons.push(`第 ${s.order} 段：${r.reasons.join('；')}`);
    }
  });
  return {
    routeName,
    passable: reasons.length === 0 && ordered.length > 0,
    totalLength,
    totalObstacles,
    totalSteps,
    maxCurbHeight,
    reasons: ordered.length === 0 ? ['尚未串联路段'] : reasons,
    valid: true,
    invalidCount: 0,
    gateNotes: [],
  };
}

/** 取每个点位最新一条核验（按核验日期，同日按创建时间） */
export function latestInspections(inspections: Inspection[]): Map<string, Inspection> {
  const map = new Map<string, Inspection>();
  for (const ins of inspections) {
    const cur = map.get(ins.pointId);
    if (!cur || cur.date < ins.date || (cur.date === ins.date && cur.createdAt < ins.createdAt)) {
      map.set(ins.pointId, ins);
    }
  }
  return map;
}

export interface SegRecalcInput {
  id: string;
  routeName: string;
  fromPointId: string;
  toPointId: string;
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  order: number;
  state?: RouteSegment['state'];
}

export interface RecalculatedSegment {
  id: string;
  wheelchairPassable: boolean;
  state: RouteSegment['state'];
  stateReason: string;
  gateNote: string;
}

/**
 * 最新核验结论驱动的路线段重算：
 * - 端点缺失 → 失效（几何信息不足），stateReason 记录原因
 * - 端点最新结论「不合格」→ wheelchairPassable=false 阻断
 * - 「限期整改」→ 警示但不阻断（gateNote）
 * - 再叠加逐段障碍/台阶/高差判定；有效段重算通过后 state 恢复为「有效」
 */
export function recalcSegments(
  segments: SegRecalcInput[],
  points: Pick<AccessPoint, 'id' | 'name'>[],
  inspections: Inspection[],
): RecalculatedSegment[] {
  const pointMap = new Map(points.map((p) => [p.id, p]));
  const latest = latestInspections(inspections);

  return segments.map((seg) => {
    const from = pointMap.get(seg.fromPointId);
    const to = pointMap.get(seg.toPointId);

    if (!from || !to) {
      const missing = [!from ? seg.fromPointId : '', !to ? seg.toPointId : ''].filter(Boolean);
      const stateReason = `端点点位缺失（${missing.join('、')}），几何信息不足，等待补点后重试`;
      return {
        id: seg.id,
        wheelchairPassable: false,
        state: '失效' as const,
        stateReason,
        gateNote: stateReason,
      };
    }

    const reasons: string[] = [];
    const gateNotes: string[] = [];
    for (const [role, p] of [
      ['起点', from],
      ['终点', to],
    ] as const) {
      const ins = latest.get(p.id);
      if (!ins) {
        gateNotes.push(`${role}「${p.name}」尚未核验`);
      } else if (ins.conclusion === '不合格') {
        reasons.push(`${role}「${p.name}」最新核验不合格（${ins.date}），禁止轮椅通行`);
      } else if (ins.conclusion === '限期整改') {
        gateNotes.push(`${role}「${p.name}」限期整改，通行需谨慎`);
      }
    }
    reasons.push(...judgeSegment(seg).reasons);

    return {
      id: seg.id,
      wheelchairPassable: reasons.length === 0,
      state: '有效' as const,
      stateReason: '',
      gateNote: gateNotes.join('；'),
    };
  });
}

/**
 * 按路线分组生成全线判定。任一段失效则该路线全线判定不可继续展示
 * （valid=false 时 UI 不显示旧结论，只显示「已失效，等待重算」）。
 */
export function buildRouteVerdicts(
  segments: RouteSegment[],
  points: Pick<AccessPoint, 'id' | 'name'>[],
  inspections: Inspection[],
): Map<string, RouteVerdict> {
  const byName = new Map<string, RouteSegment[]>();
  for (const s of segments) {
    const list = byName.get(s.routeName) ?? [];
    list.push(s);
    byName.set(s.routeName, list);
  }

  const recalced = recalcSegments(segments, points, inspections);
  const recalcMap = new Map(recalced.map((r) => [r.id, r]));

  const result = new Map<string, RouteVerdict>();
  byName.forEach((list, name) => {
    const ordered = [...list].sort((a, b) => a.order - b.order);
    const totalLength = Math.round(ordered.reduce((n, s) => n + (Number(s.length) || 0), 0) * 10) / 10;
    const totalObstacles = ordered.reduce((n, s) => n + (Number(s.obstacleCount) || 0), 0);
    const totalSteps = ordered.reduce((n, s) => n + (Number(s.stepCount) || 0), 0);
    const maxCurbHeight = ordered.reduce((n, s) => Math.max(n, Number(s.curbHeight) || 0), 0);

    const reasons: string[] = [];
    const gateNotes: string[] = [];
    let invalidCount = 0;
    let blocked = 0;
    for (const s of ordered) {
      const r = recalcMap.get(s.id);
      if (!r) continue;
      if (r.state === '失效') invalidCount += 1;
      if (r.gateNote) gateNotes.push(r.gateNote);
      if (!r.wheelchairPassable) {
        blocked += 1;
        if (r.state !== '失效') {
          // 段自身障碍原因（不含端点点位缺失）
          reasons.push(`第 ${s.order} 段：${judgeSegment(s).reasons.join('；')}`);
          const insBlock = r.gateNote.includes('不合格');
          if (insBlock) reasons.push(`第 ${s.order} 段：端点最新核验不合格，门控阻断`);
        }
      }
    }

    result.set(name, {
      routeName: name,
      passable: blocked === 0 && invalidCount === 0 && ordered.length > 0,
      totalLength,
      totalObstacles,
      totalSteps,
      maxCurbHeight,
      reasons: Array.from(new Set(reasons)),
      valid: invalidCount === 0 && ordered.length > 0,
      invalidCount,
      gateNotes: Array.from(new Set(gateNotes)),
    });
  });
  return result;
}
