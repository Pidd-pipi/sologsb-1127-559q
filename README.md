# sologsb-1127 城市无障碍设施核验地图（gbaccessmap）

面向无障碍督导员与轮椅使用者代表，把坡道、盲道、无障碍电梯的点位、核验数据与通行路线集中到一张图上。

## 一键启动（Docker）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：<http://localhost:21827>

停止服务（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 分层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 + @ant-design/icons |
| 构建 | Vite 6（`tsc -b && vite build`，构建含类型检查） |
| 状态管理 | Zustand 5（业务数据 store + UI 偏好 persist 到 localStorage） |
| 路由 | React Router 6（BrowserRouter，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`，留空时自动降级为本地 SVG 网格视图） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbaccessmap-db`）+ localStorage（表单草稿、UI 偏好） |
| 托管 | nginx:alpine（多阶段构建） |

## 核心功能

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 核验总览：按行政区与设施类型汇总点位数、合格率、待整改数，点击统计块下钻清单 | AccessPoint / Inspection / RectifyPlan |
| `/points/new` | 点位登记：地图打点或手填经纬度，可同时录入首次核验实测值 | AccessPoint / Inspection |
| `/points/:id` | 点位详情：地图定位与属性、核验历史、就地新增核验、整改跟踪 | 四个模型 |
| `/routes` | 通行路线编制：选点自动串联路段，逐段填障碍数/台阶数/路缘高差，输出全线判定 | RouteSegment / AccessPoint |
| `/map` | 设施地图：按设施类型着色渲染点位，点选弹出核验摘要 | AccessPoint / Inspection |
| `/rectify` | 整改清单：按状态与期限分组、逾期置顶，登记复检结果 | RectifyPlan / AccessPoint |
| `/offline` | 离线核验包：导出选中点位及相关记录、回传三路合并、并排冲突裁决、整包暂存重试、现场端断网模拟 | 四个模型 + SyncMeta |

## 数据模型（`src/types/` 独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| AccessPoint | `src/types/point.ts` | 点位编号、名称、设施类型、经纬度、行政区、所在道路或建筑、建成年代、养护单位 |
| Inspection | `src/types/inspection.ts` | 核验日期、核验人、坡度 %、净宽 cm、扶手、盲道连续性、占用情况、结论、问题描述 |
| RouteSegment | `src/types/route.ts` | 路线名称、起点/终点点位、长度、障碍数、台阶数、路缘高差、是否可轮椅通行 |
| RectifyPlan | `src/types/rectify.ts` | 点位 id、整改要求、责任单位、整改期限、复检日期、状态 |

## 数据存储

- **IndexedDB（Dexie，库名 `gbaccessmap-db`）**：业务数据。含版本号与升级迁移：
  - `v1` 建 `points` / `inspections` 表；
  - `v2` 增加 `routes` 表与 `pointId` 相关索引；
  - `v3` 增加 `rectifies` 表，并为历史「不合格」核验补建整改条目；
  - `v4` 为三类业务实体补修订元数据（`rev`/`fieldRev`/`deviceId`/`syncedAt`），新增 `stagedPackages`（整包留待重试）、`appliedOps`（应用幂等）、`seenInspections`（核验只补一次）。
- **localStorage**：点位登记表单草稿（`gbaccessmap-draft:point-new`）与 UI 偏好（`gbaccessmap-ui`）。
- 首次打开时自动写入一批示例数据，便于直接体验。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器存储即可重置数据。

## 高德地图 key

`VITE_AMAP_KEY` 留空（默认）时：`useAmapLoader()` 检测到 key 为空会**立即**返回降级标记，**不会**请求 `webapi.amap.com`；页面渲染可点选、可查看详情的本地 SVG 网格视图（`MapPanel`）。配置了 key 时脚本加载失败或超时同样自动降级，因此构建与运行都不依赖该 key。

## 目录结构

```
sologsb-1127/
├── docker-compose.yml          # 顶层 name: gbaccessmap，无 version: 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── README.md
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files + gzip
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig*.json
    ├── public/favicon.svg
    └── src/
        ├── types/{point,inspection,route,rectify,sync}.ts
        ├── db/index.ts                     # Dexie 封装 + 版本迁移 + 示例数据
        ├── sync/{merge,revision,packageService}.ts  # 三路合并 / 修订号 / 离线包导入导出
        ├── stores/{pointStore,routeStore,uiStore}.ts
        ├── components/common/{MapPanel,StatusBadge,FacilityIcon,MeasureInput,EmptyState}.tsx
        ├── hooks/{useAmapLoader,useInspectionFilter,useLocalDraft}.ts
        ├── pages/{Overview,PointNew,PointDetail,Routes,MapView,Rectify,OfflineSync}.tsx
        ├── layouts/AppLayout.tsx
        ├── router/index.tsx
        └── utils/{routeCheck,geo,format}.ts
```

## 判定阈值（`src/utils/routeCheck.ts`）

- 坡度：≤ 5% 合格，> 5% 限期整改，> 8% 不合格；
- 净宽：≥ 120cm 合格，< 120cm 限期整改，< 90cm 不合格；
- 路缘高差：≤ 3cm 可轮椅通行，> 6cm 判定不可通行；存在台阶需绕行或增设坡道。

## 离线核验包（现场断网作业 / 回传合并）

面向「现场督导员断网修改 → 回传办公室合并」的完整闭环，代码在 `src/sync/` 与 `/offline` 页面。

**修订号模型（`types/sync.ts`、`sync/revision.ts`）**

- 点位 / 核验 / 整改三类实体各带 `rev`（实体修订号）与 `fieldRev`（逐字段修订号）、`deviceId`、`syncedAt`；
- 任何写入（登记、复检、导入合并）都只抬高真正改动字段的修订号，未改字段不动。

**导出与回传**

- 导出选中点位时，连同其核验记录、整改条目与一份「基线快照」（`base`）一起打包；
- 现场端断网修改后封存为回传包（`kind=return`）；页内「现场端断网模拟」可在单设备演练全过程。

**按修订号逐字段三路合并（`sync/merge.ts`）**

- 以基线为参照逐字段比对：只有一侧改过 → 自动并入；两侧改成不同值 → 进入并排裁决；
- 字段修订号有高低时高版本自动获胜；**仅当两侧同修订号并发改成不同值才要求人工裁决**，裁决不以时间新旧为准，晚到的一份不会覆盖；
- 合并产物的 `rev`/`fieldRev` 严格高于双方，后到旧包的旧值无法回灌。

**整包原子性（`sync/packageService.ts`，Dexie v4）**

- 新增 `stagedPackages` / `appliedOps` / `seenInspections` 三张表；
- 导入中断、点位不足、冲突未裁决时**整包**原样留存在暂存区（状态 failed / conflict），不写任何半截数据，可随时「整包重试」；
- 应用在单一大事务内执行，`appliedOps` 按 `(packageId, 实体)` 去重，重试不会二次生效；
- **点位不足先不写**：被引用点位在包内与本地都缺失时整包挂起，补齐后重试即可；
- 同一核验按业务指纹（点位+日期+核验人+实测值+结论，与 id/设备无关）识别，**重复回传只补一次**。

**路线段联动失效（`utils/routeLive.ts`）**

- 路线判定不缓存旧结论，始终用「最新点位 + 最新核验结论」实时派生；
- 最新核验结论为不合格/限期整改、或端点点位变化（缺失/坐标移动）时，相关路段**立即失效**并按新坐标重算长度，页面以「已失效」呈现并列出原因，旧全线结论不再显示；
- 录入核验、登记复检、导入应用任一数据变化都会触发该重算。
