import assert from 'node:assert/strict';
import { planMerge } from '../src/sync/package';
import type { AccessPoint } from '../src/types/point';
import type { Inspection } from '../src/types/inspection';
import type { RectifyPlan } from '../src/types/rectify';
import type { RouteSegment } from '../src/types/route';
import type { AnyEntity, OfflinePackage, PackageEntity } from '../src/types/sync';
import { PACKAGE_FORMAT } from '../src/types/sync';
import { inspectionFingerprint } from '../src/sync/fields';
import { mergeEntity } from '../src/sync/merge';
import { recalcSegments } from '../src/utils/routeCheck';
import type { SyncedEntityShape } from '../src/sync/merge';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
  }
}

const now = '2026-10-06T08:00:00.000Z';

function point(over: Partial<AccessPoint> = {}): AccessPoint {
  return {
    id: 'pt-1',
    code: 'WZ-2026-001',
    name: '测试坡道',
    facilityType: '缘石坡道',
    lng: 116.4,
    lat: 39.9,
    district: '东城区',
    location: '路口',
    builtYear: 2020,
    maintainUnit: '市政一所',
    createdAt: now,
    updatedAt: now,
    rev: 1,
    fieldRevs: {},
    syncBase: null,
    ...over,
  };
}

function pack<T extends AnyEntity>(entity: T, base: Record<string, unknown> | null): PackageEntity<T> {
  return { entity, base };
}

function pkg(
  points: PackageEntity<AccessPoint>[] = [],
  inspections: PackageEntity<Inspection>[] = [],
  rectifies: PackageEntity<RectifyPlan>[] = [],
  routes: PackageEntity<RouteSegment>[] = [],
): OfflinePackage {
  return {
    format: PACKAGE_FORMAT,
    version: 1,
    packageId: `pkg-${Math.random().toString(36).slice(2, 8)}`,
    exportedAt: now,
    exportedBy: '现场督导员',
    deviceId: 'dev-field',
    pointIds: points.map((p) => p.entity.id),
    points,
    inspections,
    rectifies,
    routes,
  };
}

export function runSelfTest(): void {
  // 1. 只有现场改过基线字段 → 晚到值应合入，即使包后到
  test('仅现场一侧相对基线改过：晚到包合入，不被本机旧值挡住', () => {
    // 本机自导出后未再修改（syncBase 就是基线）；现场包携带同基线并改了 name
    const local = point({ name: '基线名称', syncBase: { name: '基线名称' } as never });
    const remote = point({ name: '现场新名称', syncBase: { name: '基线名称' } as never });
    const r = mergeEntity(
      'point',
      local as unknown as SyncedEntityShape,
      pack(remote, { name: '基线名称' }),
      remote.id,
      '测试点位',
      {},
    );
    assert.equal((r.merged as AccessPoint).name, '现场新名称');
    assert.equal(r.conflicts.length, 0);
  });

  // 2. 两边都改 → 冲突，未裁决前保留本机值（晚到的一份不能覆盖）
  test('两边都改过且取值不同：产生冲突，默认保留本机值', () => {
    const local = point({ name: '本机改', syncBase: { name: '基线' } as never, rev: 2 });
    const remote = point({ name: '现场改', syncBase: { name: '基线' } as never, rev: 2 });
    const r = mergeEntity(
      'point',
      local as unknown as SyncedEntityShape,
      pack(remote, { name: '基线' }),
      remote.id,
      '测试点位',
      {},
    );
    assert.equal(r.conflicts.length, 1);
    assert.equal((r.merged as AccessPoint).name, '本机改');
  });

  // 3. 裁决选现场值后采用现场值
  test('并排裁决选择现场值后合入', () => {
    const local = point({ name: '本机改', syncBase: { name: '基线' } as never, rev: 2 });
    const remote = point({ name: '现场改', syncBase: { name: '基线' } as never, rev: 2 });
    const r = mergeEntity(
      'point',
      local as unknown as SyncedEntityShape,
      pack(remote, { name: '基线' }),
      remote.id,
      '测试点位',
      { 'point:pt-1:name': 'remote' },
    );
    assert.equal((r.merged as AccessPoint).name, '现场改');
  });

  // 4. 无基线，按字段修订号，晚到低修订号不覆盖
  test('无基线时低修订号晚到不能覆盖高修订号本机值', () => {
    const local = point({ name: '本机v2', fieldRevs: { name: 2 }, rev: 2 });
    const remote = point({ name: '现场v1', fieldRevs: { name: 1 }, rev: 1 });
    const r = mergeEntity(
      'point',
      local as unknown as SyncedEntityShape,
      pack(remote, null),
      remote.id,
      '测试点位',
      {},
    );
    assert.equal((r.merged as AccessPoint).name, '本机v2');
    assert.equal(r.conflicts.length, 0);
  });

  // 5. 同一核验重复回传只补一次（指纹去重）
  test('同一核验指纹重复回传：第二次整段跳过', () => {
    const insp: Inspection = {
      id: 'ins-1',
      pointId: 'pt-1',
      date: '2026-10-05',
      inspector: '李维',
      slope: 9.5,
      clearWidth: 80,
      hasHandrail: false,
      tactileContinuous: false,
      occupied: '长期占用',
      conclusion: '不合格',
      problem: '同一次核验',
      createdAt: now,
      rev: 1,
      fieldRevs: {},
      syncBase: null,
    };
    const local = { points: [point()], inspections: [] as Inspection[], rectifies: [] as RectifyPlan[], routes: [] as RouteSegment[] };
    const p1 = pkg([pack(point(), null)], [pack(insp, null)]);
    const first = planMerge(local, p1, {});
    assert.equal(first.inspections.added, 1);
    // 同包再传：本地状态不变（模拟已补录）
    const local2 = {
      points: [point()],
      inspections: [{ ...insp }],
      rectifies: [] as RectifyPlan[],
      routes: [] as RouteSegment[],
    };
    const second = planMerge(local2, p1, {});
    assert.equal(second.inspections.skipped, 1);
    assert.equal(second.puts.inspections.length, 0);
    assert.equal(inspectionFingerprint(insp).includes('pt-1'), true);
  });

  // 6. 点位不足 → 整包不写
  test('引用点位缺失（包内本地都没有）：整包留待重试，puts 全空', () => {
    const insp: Inspection = {
      id: 'ins-9',
      pointId: 'pt-missing',
      date: '2026-10-05',
      inspector: '李维',
      slope: 3,
      clearWidth: 150,
      hasHandrail: true,
      tactileContinuous: true,
      occupied: '无',
      conclusion: '合格',
      problem: '',
      createdAt: now,
      rev: 1,
      fieldRevs: {},
      syncBase: null,
    };
    const local = { points: [point()], inspections: [], rectifies: [], routes: [] as RouteSegment[] };
    const p = pkg([], [pack(insp, null)]);
    const out = planMerge(local, p, {});
    assert.deepEqual(out.missingPointIds, ['pt-missing']);
    assert.equal(out.puts.inspections.length, 0);
    assert.equal(out.puts.points.length, 0);
  });

  // 7. 最新核验「不合格」→ 相关路线段立即不可通行；「限期整改」只警示
  test('最新核验结论变化：不合格路段门控阻断，限期整改仅警示', () => {
    const seg = (id: string, from: string, to: string): RouteSegment => ({
      id,
      routeName: 'R',
      fromPointId: from,
      toPointId: to,
      length: 100,
      obstacleCount: 0,
      stepCount: 0,
      curbHeight: 1,
      wheelchairPassable: true,
      order: 1,
      createdAt: now,
      rev: 1,
      fieldRevs: {},
      syncBase: null,
      state: '有效',
      stateReason: '',
      rebuiltAt: now,
    });
    const pts = [
      point({ id: 'pt-a', name: 'A' }),
      point({ id: 'pt-b', name: 'B' }),
      point({ id: 'pt-c', name: 'C' }),
    ];
    const ins: Inspection[] = [
      {
        id: 'i-a',
        pointId: 'pt-a',
        date: '2026-10-01',
        inspector: 'x',
        slope: 2,
        clearWidth: 150,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        conclusion: '不合格',
        problem: '',
        createdAt: now,
        rev: 1,
        fieldRevs: {},
        syncBase: null,
      },
      {
        id: 'i-b',
        pointId: 'pt-b',
        date: '2026-10-02',
        inspector: 'x',
        slope: 2,
        clearWidth: 130,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '临时占用',
        conclusion: '限期整改',
        problem: '',
        createdAt: now,
        rev: 1,
        fieldRevs: {},
        syncBase: null,
      },
    ];
    const segs = [seg('s1', 'pt-a', 'pt-b'), seg('s2', 'pt-b', 'pt-c')];
    const out = recalcSegments(segs, pts, ins);
    const map = new Map(out.map((r) => [r.id, r]));
    assert.equal(map.get('s1')!.wheelchairPassable, false, '不合格端点应阻断');
    assert.equal(map.get('s1')!.state, '有效');
    assert.equal(map.get('s2')!.wheelchairPassable, true, '限期整改不应阻断');
    assert.match(map.get('s2')!.gateNote, /限期整改/);
  });

  // 8. 端点点位缺失 → 路段失效
  test('端点点位缺失：路线段状态为失效并给出原因', () => {
    const seg: RouteSegment = {
      id: 's-x',
      routeName: 'R',
      fromPointId: 'pt-a',
      toPointId: 'pt-gone',
      length: 10,
      obstacleCount: 0,
      stepCount: 0,
      curbHeight: 1,
      wheelchairPassable: true,
      order: 1,
      createdAt: now,
      rev: 1,
      fieldRevs: {},
      syncBase: null,
      state: '有效',
      stateReason: '',
      rebuiltAt: now,
    };
    const out = recalcSegments([seg], [point({ id: 'pt-a' })], []);
    assert.equal(out[0].state, '失效');
    assert.match(out[0].stateReason, /点位缺失/);
  });

  if (failures) {
    throw new Error(`${failures} 个自测用例失败`);
  }
}
