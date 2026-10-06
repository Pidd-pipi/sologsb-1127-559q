import type { SyncedRecord } from './sync';

/** 路线段状态：最新核验结论或点位变化后立即失效，重算通过后恢复 */
export type SegmentState = '有效' | '失效';

/** 通行路线段 */
export interface RouteSegment extends SyncedRecord {
  id: string;
  /** 路线名称，同一条路线的多段共用一个名称 */
  routeName: string;
  fromPointId: string;
  toPointId: string;
  /** 长度 m */
  length: number;
  /** 沿途障碍数 */
  obstacleCount: number;
  /** 台阶数 */
  stepCount: number;
  /** 路缘高差 cm */
  curbHeight: number;
  /** 是否可轮椅通行（由逐段核验判定） */
  wheelchairPassable: boolean;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  createdAt: string;
  /** 失效重算状态；旧全线结论在失效期间不能继续显示 */
  state: SegmentState;
  /** 失效原因（端点核验结论变化、端点缺失等），重算后清空 */
  stateReason: string;
  /** 最近一次重算时间（不被端点结论影响的普通编辑不重算） */
  rebuiltAt: string;
}

export type RouteSegmentDraft = Omit<
  RouteSegment,
  'id' | 'createdAt' | 'wheelchairPassable' | 'rev' | 'fieldRevs' | 'syncBase' | 'state' | 'stateReason' | 'rebuiltAt'
>;

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  reasons: string[];
  /** 是否全部路段都已重算为有效；false 时旧全线结论不可继续显示 */
  valid: boolean;
  invalidCount: number;
  /** 全线各段最新核验结论给出的门控原因（合格放行 / 限期整改警示 / 不合格阻断） */
  gateNotes: string[];
}
