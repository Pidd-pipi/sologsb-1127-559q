import type { AccessPoint } from '../types/point';
import type { Inspection, InspectionConclusion } from '../types/inspection';
import type { RouteSegment, RouteVerdict } from '../types/route';
import { segmentLength } from './geo';
import { judgeSegment } from './routeCheck';

/**
 * 路线段实时上下文。路线段是否仍有效，不做长期缓存结论：
 * 每次判定都用「最新点位 + 最新核验结论」现场派生，
 * 因此点位变化或最新核验结论变化后，旧的全线结论不可能继续显示。
 */
export interface SegmentContext {
  points: AccessPoint[];
  inspections: Inspection[];
}

export interface SegmentState {
  state: RouteSegment['validState'];
  reasons: string[];
  /** 依据当前点位坐标重算出的长度（m），坐标未变时与原长度一致 */
  derivedLength: number;
}

/** 端点存在但最新核验结论不可放行的结论 */
const BLOCKING_CONCLUSIONS: InspectionConclusion[] = ['不合格', '限期整改'];

/** 单个路线段的实时有效性判定 */
export function deriveSegmentState(seg: RouteSegment, ctx: SegmentContext): SegmentState {
  const reasons: string[] = [];
  const from = ctx.points.find((p) => p.id === seg.fromPointId);
  const to = ctx.points.find((p) => p.id === seg.toPointId);

  let derivedLength = seg.length;
  if (from && to) {
    derivedLength = segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat });
  }

  if (!from || !to) {
    return {
      state: 'invalid',
      reasons: [`端点点位缺失（${!from ? seg.fromPointId : ''}${!from && !to ? '、' : ''}${!to ? seg.toPointId : ''}），路段立即失效`],
      derivedLength,
    };
  }

  const latestOf = (pointId: string): Inspection | undefined => {
    const list = ctx.inspections
      .filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
    return list[0];
  };

  for (const [p, label] of [
    [from, '起点'],
    [to, '终点'],
  ] as const) {
    const latest = latestOf(p.id);
    if (latest && BLOCKING_CONCLUSIONS.includes(latest.conclusion)) {
      reasons.push(`${label}「${p.name}」最新核验结论为「${latest.conclusion}」（${latest.date}），相关路段立即失效待重算`);
    }
  }

  const geo = judgeSegment(seg);
  if (!geo.passable) reasons.push(...geo.reasons);

  return { state: reasons.length ? 'invalid' : 'fresh', reasons, derivedLength };
}

/**
 * 全线判定：在原几何判定之上叠加「端点最新核验结论 / 点位存在性」实时校验，
 * 任一段失效则整条路线不可放行，并显式列出失效段与原因，杜绝旧全线结论继续展示。
 */
export function buildLiveVerdict(
  routeName: string,
  segments: RouteSegment[],
  ctx: SegmentContext,
): RouteVerdict {
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  const totalLength =
    Math.round(ordered.reduce((n, s) => n + (deriveSegmentState(s, ctx).derivedLength || 0), 0) * 10) / 10;
  const totalObstacles = ordered.reduce((n, s) => n + (Number(s.obstacleCount) || 0), 0);
  const totalSteps = ordered.reduce((n, s) => n + (Number(s.stepCount) || 0), 0);
  const maxCurbHeight = ordered.reduce((n, s) => Math.max(n, Number(s.curbHeight) || 0), 0);
  const reasons: string[] = [];
  let invalid = false;
  ordered.forEach((s) => {
    const r = deriveSegmentState(s, ctx);
    if (r.state === 'invalid') {
      invalid = true;
      reasons.push(`第 ${s.order} 段已失效：${r.reasons.join('；')}`);
    }
  });
  return {
    routeName,
    passable: !invalid && ordered.length > 0,
    hasInvalidSegments: invalid,
    totalLength,
    totalObstacles,
    totalSteps,
    maxCurbHeight,
    reasons: ordered.length === 0 ? ['尚未串联路段'] : reasons,
  };
}

/** 找出因给定点位集合（点位变化 / 最新核验结论变化）而失效的路段 */
export function affectedSegments(
  allSegments: RouteSegment[],
  touchedPointIds: Set<string>,
): RouteSegment[] {
  return allSegments.filter(
    (s) => touchedPointIds.has(s.fromPointId) || touchedPointIds.has(s.toPointId),
  );
}
