/** 核验结论 */
export type InspectionConclusion = '合格' | '限期整改' | '不合格';

export const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];

/** 被占用情况 */
export type OccupiedLevel = '无' | '临时占用' | '长期占用';

export const OCCUPIED_LEVELS: OccupiedLevel[] = ['无', '临时占用', '长期占用'];

/** 核验记录 */
export interface Inspection {
  id: string;
  pointId: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  inspector: string;
  /** 坡度 % */
  slope: number;
  /** 净宽 cm */
  clearWidth: number;
  /** 扶手有无 */
  hasHandrail: boolean;
  /** 盲道连续性 */
  tactileContinuous: boolean;
  /** 被占用情况 */
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
  createdAt: string;
}

export type InspectionDraft = Omit<Inspection, 'id' | 'createdAt'>;
