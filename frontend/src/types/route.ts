/** 通行路线段 */
export interface RouteSegment {
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
  /**
   * 审计字段：最近一次写入/导入时的实时状态。
   * fresh=端点齐全且最新核验结论放行；invalid=点位变化或最新核验结论变化后已失效。
   * 展示判定时仍以 routeLive 实时派生为准，此字段仅用于列表标识，旧全线结论不会被缓存复用。
   */
  validState?: 'fresh' | 'invalid';
  /** 失效原因（validState=invalid 时） */
  invalidReason?: string;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  createdAt: string;
}

export type RouteSegmentDraft = Omit<RouteSegment, 'id' | 'createdAt' | 'wheelchairPassable'>;

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  /** 是否存在已失效路段（点位变化或最新核验结论变化触发，需重算） */
  hasInvalidSegments: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  reasons: string[];
}
