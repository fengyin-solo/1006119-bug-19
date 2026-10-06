# 盾构隧道掘进施工管理平台

面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 盾构机台账 | `shield` | 盾构机 | 盾构机编号、盾构机型号、开挖直径 |
| 掘进环次 | `ring` | 掘进环 | 环号、起始里程、掘进速度 |
| 管片拼装 | `segment` | 管片环 | 管片环号、管片型号、拼装点位 |
| 同步注浆 | `grouting` | 注浆记录 | 注浆编号、对应环号、浆液配比 |
| 渣土外运 | `muck` | 渣土运输单 | 运输单号、对应环号、渣土方量 |
| 地表沉降 | `settlement` | 沉降测点 | 测点编号、测点位置、初始高程 |
| 轴线偏差 | `axis` | 轴线测量 | 测量编号、对应环号、设计轴线 |
| 刀具磨损 | `cutter` | 刀具 | 刀具编号、刀盘位置、刀具类型 |
| 管片生产 | `segmentprod` | 管片 | 管片编号、管片型号、生产模具 |
| 浆液拌制 | `mortar` | 浆液批次 | 批次编号、浆液类型、水泥用量 |
| 洞内通风 | `ventilation` | 通风机组 | 机组编号、风筒长度、送风量 |
| 建筑监测 | `building` | 监测对象 | 对象编号、建筑物名称、结构类型 |
| 管线探查 | `utility` | 地下管线 | 管线编号、管线类型、埋设深度 |
| 进度节点 | `progress` | 进度节点 | 节点编号、节点名称、计划完成日 |
| 试验检测 | `testing` | 试验委托 | 委托编号、试样类型、检测项目 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练科目、演练日期 |
| 班组进场 | `crew` | 施工班组 | 班组编号、班组名称、主要工种 |
| 安全巡检 | `safety` | 巡检记录 | 巡检编号、巡检区域、巡检项目 |

## 进度节点：统一台账、导出册子与交付清单

进度节点（`progress`）不走通用清单，而是以 `src/data/progress-ledger.ts` 的**节点台账为唯一事实源**：

- **同一份取数**：列表页（`listEntries('progress')`）、导出 CSV（`exportProgressCsv`）、分卷册子
  （`progress-export.ts`）、掘进环次交付清单（`ring-deliveries.ts`）全部从 `readLedger()` 出数，
  不允许页面临时拼字段、导出另走一路。偏差天数列不入库，由 `calcDeviationDays` 统一现算：
  - 已完成节点：`实际完成日 − 计划完成日`；
  - 在办节点：`今天 − 计划完成日`。
  算法版本号是 `DEVIATION_ALGORITHM_VERSION`，改算法只动这一处，已生成的交付清单可一键重算。
- **缺栏逐列标注**：导出/册子列顺序固定，「计划完成日」整列必在；必填栏为空的单元格写
  「【缺栏】」，末尾「缺栏列」逐列列出列名。
- **补录节点**：带补录标记的节点和正常节点同一台账，必然出现在列表、导出与册子里。
- **分卷打包、断点续传**：提交任务时按计划完成日切分卷（默认每卷 10 个）并冻结节点 id 清单；
  `packNextVolume` 每次只打第一卷未完成的卷，中途断了从断掉的那卷接着打，已完成卷不重打，
  未打好的卷不会混进整册（不留半包）。同一台账（指纹相同）重复提交只生效一次，直接复用原任务。
- **计划完成日冻结 / 越权驳回**：已确认完成的节点计划完成日冻结，任何环节（页面改期、导出打包）
  改动都直接驳回并说明卡在第几步；改期需「计划工程师」及以上角色（值班员越权驳回）。
- **交付清单**：全卷打完后结论写入掘进环次页面（`DEL-*`，按任务幂等）；清单里的已完成节点数
  与进度页共用 `completedNodeCount()`，页面上可对账、可按新算法重算。
- **存量重新入库（rehouse）**：顺序固定为「读存量 → 同编号重复登记只留最早一条 → 按计划完成日
  升序重排重编号 → 原子落库」；落库失败由事务层整套撤回。运营概览页的进度节点条数读同步后的
  同一份数据，两边不分两份。

台账相关 localStorage 键（统一前缀 `shield-tunnel-construction:`）：
`:progress-ledger`、`:progress-meta`、`:export-jobs`、`:ring-deliveries`，
通用清单键 `:entries` 里的 progress 是台账派生同步值，仅用于概览计数。

## 测试

```bash
cd frontend
npm test        # 台账/去重/偏差/分卷续传/冻结驳回/交付清单/事务回滚/服务层端到端
npm run build   # vue-tsc 类型检查 + 生产构建
```

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`；进度节点的页面/导出/册子/交付清单统一走
  `frontend/src/data/progress-*.ts` 与 `ring-deliveries.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`（进度节点种子在 `frontend/src/data/progress-seed.ts`）。
- 状态流转只允许在 `local-service.ts` 与 `progress-ledger.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `shield-tunnel-construction:entries` 及
  `shield-tunnel-construction:progress-*`、`:export-jobs`、`:ring-deliveries` 各项，
  或调用 `resetModule(模块)`。
