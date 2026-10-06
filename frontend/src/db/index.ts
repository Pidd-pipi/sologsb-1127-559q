import Dexie, { type Table } from 'dexie';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RouteSegment } from '../types/route';
import type { RectifyPlan } from '../types/rectify';
import { addDays, makeId, todayStr, toPlain } from '../utils/format';
import { judgeInspection } from '../utils/routeCheck';

export const DB_NAME = 'gbaccessmap-db';

/**
 * 浏览器本地库：IndexedDB（Dexie）
 * v1 建 points / inspections
 * v2 加 routes 表与 pointId 索引
 * v3 加 rectifies 表，并为历史不合格核验补建整改条目
 */
class AccessMapDb extends Dexie {
  points!: Table<AccessPoint, string>;
  inspections!: Table<Inspection, string>;
  routes!: Table<RouteSegment, string>;
  rectifies!: Table<RectifyPlan, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      points: 'id, code, facilityType, district, name',
      inspections: 'id, pointId, date, conclusion',
    });
    this.version(2)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
      })
      .upgrade(async (tx) => {
        // v2：把 plan 阶段遗留的 routeName 缺失记录补上默认名称
        const table = tx.table('routes');
        const rows: RouteSegment[] = await table.toArray();
        for (const row of rows) {
          if (!row.routeName) {
            await table.update(row.id, { routeName: '未命名路线' });
          }
        }
      });
    this.version(3)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
        rectifies: 'id, pointId, status, deadline',
      })
      .upgrade(async (tx) => {
        // v3：为历史「不合格」核验补建整改条目（已存在同点位待整改条目则跳过）
        const inspections: Inspection[] = await tx.table('inspections').toArray();
        const existed: RectifyPlan[] = await tx.table('rectifies').toArray();
        const pendingPointIds = new Set(
          existed.filter((r) => r.status !== '已整改').map((r) => r.pointId),
        );
        for (const insp of inspections) {
          if (insp.conclusion !== '不合格') continue;
          if (pendingPointIds.has(insp.pointId)) continue;
          pendingPointIds.add(insp.pointId);
          await tx.table('rectifies').add({
            id: `rct-mig-${insp.id}`,
            pointId: insp.pointId,
            requirement: `按核验结论整改：${insp.problem || '整改坡度、净宽与占用问题'}`,
            unit: '待指派责任单位',
            deadline: addDays(insp.date || todayStr(), 30),
            recheckDate: '',
            status: '待整改',
            createdAt: new Date().toISOString(),
          });
        }
      });
  }
}

export const db = new AccessMapDb();

const SEED_POINTS: Omit<AccessPoint, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'pt-1001',
    code: 'WZ-2024-001',
    name: '东单北大街缘石坡道',
    facilityType: '缘石坡道',
    lng: 116.4183,
    lat: 39.9142,
    district: '东城区',
    location: '东单北大街与灯市口大街交叉口东南角',
    builtYear: 2016,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1002',
    code: 'WZ-2024-002',
    name: '王府井步行街盲道',
    facilityType: '盲道',
    lng: 116.4109,
    lat: 39.915,
    district: '东城区',
    location: '王府井大街南段 118 号门前',
    builtYear: 2018,
    maintainUnit: '市政道路养护二所',
  },
  {
    id: 'pt-1003',
    code: 'WZ-2024-003',
    name: '西直门站无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.3555,
    lat: 39.9405,
    district: '西城区',
    location: '地铁西直门站 A 口地面层',
    builtYear: 2019,
    maintainUnit: '轨道交通运营部',
  },
  {
    id: 'pt-1004',
    code: 'WZ-2024-004',
    name: '朝阳公园南门轮椅坡道',
    facilityType: '轮椅坡道',
    lng: 116.4741,
    lat: 39.9339,
    district: '朝阳区',
    location: '朝阳公园南路南门西侧',
    builtYear: 2015,
    maintainUnit: '园林绿化服务中心',
  },
  {
    id: 'pt-1005',
    code: 'WZ-2024-005',
    name: '中关村广场无障碍卫生间',
    facilityType: '无障碍卫生间',
    lng: 116.3106,
    lat: 39.9842,
    district: '海淀区',
    location: '中关村大街 27 号地下二层',
    builtYear: 2020,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1006',
    code: 'WZ-2024-006',
    name: '丰台科技园低位服务台',
    facilityType: '低位服务台',
    lng: 116.2956,
    lat: 39.856,
    district: '丰台区',
    location: '丰台科技园政务大厅一层',
    builtYear: 2021,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1007',
    code: 'WZ-2024-007',
    name: '莲花池东路盲道',
    facilityType: '盲道',
    lng: 116.32,
    lat: 39.8977,
    district: '丰台区',
    location: '莲花池东路北侧辅路人行道',
    builtYear: 2014,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1008',
    code: 'WZ-2024-008',
    name: '鲁谷路无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.2213,
    lat: 39.9065,
    district: '石景山区',
    location: '鲁谷路 35 号院 3 号楼东侧',
    builtYear: 2013,
    maintainUnit: '轨道交通运营部',
  },
];

interface SeedInspection {
  pointId: string;
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: Inspection['occupied'];
  problem: string;
}

const SEED_INSPECTIONS: SeedInspection[] = [
  {
    pointId: 'pt-1001',
    date: '2025-03-12',
    inspector: '督导员 李维',
    slope: 3.2,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1002',
    date: '2025-03-14',
    inspector: '督导员 王岚',
    slope: 2.1,
    clearWidth: 130,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '无',
    problem: '盲道在路口处断开约 4 米，未设置提示盲道',
  },
  {
    pointId: 'pt-1003',
    date: '2025-04-02',
    inspector: '督导员 陈默',
    slope: 1.4,
    clearWidth: 160,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1004',
    date: '2025-04-08',
    inspector: '督导员 李维',
    slope: 6.4,
    clearWidth: 105,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '临时占用',
    problem: '坡道中段被共享单车临时占用，实际净宽不足',
  },
  {
    pointId: 'pt-1005',
    date: '2025-04-19',
    inspector: '督导员 赵敏',
    slope: 1.1,
    clearWidth: 155,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1006',
    date: '2025-05-06',
    inspector: '督导员 赵敏',
    slope: 2.6,
    clearWidth: 140,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1007',
    date: '2025-05-11',
    inspector: '督导员 王岚',
    slope: 9.5,
    clearWidth: 82,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '长期占用',
    problem: '盲道被沿街商铺货架长期占用，坡度过大且净宽不足 90cm',
  },
  {
    pointId: 'pt-1008',
    date: '2025-05-20',
    inspector: '督导员 陈默',
    slope: 1.8,
    clearWidth: 145,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
];

interface SeedRoute {
  routeName: string;
  pointIds: string[];
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
}

const SEED_ROUTES: SeedRoute[] = [
  {
    routeName: '东单—王府井轮椅通道',
    pointIds: ['pt-1001', 'pt-1002'],
    length: 640.5,
    obstacleCount: 1,
    stepCount: 0,
    curbHeight: 2,
  },
];

function buildSeed() {
  const now = new Date().toISOString();
  const today = todayStr();
  const points: AccessPoint[] = SEED_POINTS.map((p) => ({ ...p, createdAt: now, updatedAt: now }));
  const inspections: Inspection[] = SEED_INSPECTIONS.map((s, i) => {
    const judged = judgeInspection({
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
    });
    return {
      id: `ins-seed-${i + 1}`,
      pointId: s.pointId,
      date: s.date,
      inspector: s.inspector,
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
      conclusion: judged.conclusion,
      problem: s.problem,
      createdAt: now,
    };
  });
  const routes: RouteSegment[] = [];
  SEED_ROUTES.forEach((r, ri) => {
    for (let i = 1; i < r.pointIds.length; i += 1) {
      routes.push({
        id: `rts-seed-${ri + 1}-${i}`,
        routeName: r.routeName,
        fromPointId: r.pointIds[i - 1],
        toPointId: r.pointIds[i],
        length: Math.round((r.length / (r.pointIds.length - 1)) * 10) / 10,
        obstacleCount: r.obstacleCount,
        stepCount: r.stepCount,
        curbHeight: r.curbHeight,
        wheelchairPassable: r.stepCount === 0 && r.curbHeight <= 3 && r.obstacleCount <= 2,
        order: i,
        createdAt: now,
      });
    }
  });
  const rectifies: RectifyPlan[] = [
    {
      id: 'rct-seed-1',
      pointId: 'pt-1007',
      requirement: '清退盲道上的商铺货架，重做坡道并加装扶手，复测净宽不低于 120cm',
      unit: '市政道路养护一所',
      deadline: addDays(today, -21),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-2',
      pointId: 'pt-1002',
      requirement: '补齐路口断开的盲道并增设提示盲道',
      unit: '市政道路养护二所',
      deadline: addDays(today, -6),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-3',
      pointId: 'pt-1004',
      requirement: '划设共享单车禁停区，恢复坡道净宽至 120cm 以上',
      unit: '园林绿化服务中心',
      deadline: addDays(today, 18),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-4',
      pointId: 'pt-1008',
      requirement: '更换电梯轿厢呼叫按钮盲文标识',
      unit: '轨道交通运营部',
      deadline: addDays(today, -40),
      recheckDate: addDays(today, -12),
      status: '已整改',
      createdAt: now,
    },
  ];
  return { points, inspections, routes, rectifies };
}

/** 首次打开时写入示例数据；已有数据则跳过 */
export async function ensureSeed(): Promise<void> {
  const count = await db.points.count();
  if (count > 0) return;
  const seed = toPlain(buildSeed());
  await db.transaction('rw', db.points, db.inspections, db.routes, db.rectifies, async () => {
    await db.points.bulkPut(seed.points);
    await db.inspections.bulkPut(seed.inspections);
    await db.routes.bulkPut(seed.routes);
    await db.rectifies.bulkPut(seed.rectifies);
  });
}

export { makeId };
