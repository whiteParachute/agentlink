# M1 control-plane reuse boundary (AL-M1-001)

> 文档状态：Draft 1（AL-M1-001 交付）
> 创建日期：2026-06-12
> 范围：docs-only。本文不改功能代码、不改 schema、不改测试。
> 关联：新版 Agentlink PRD《记忆优先的多入口 Agent 协作与执行路由系统》（`HJ7gdnTcDoCx1HxCyRzcr2zyngb`，revision 53）§12.2 研发任务切片。

## 1. Purpose

新版 Agentlink PRD 把产品主轴从“多设备 Agent 控制面”改写为“记忆优先的多入口 Agent 协作与执行路由系统”。已完成的旧控制面实现（`AL-TD-001` ~ `AL-TD-009`，截至 HEAD `e0c9117`）**不废弃**，而是降级为 memory-first M1 的 **execution substrate（执行底座）**。

本文的目标是为后续 `AL-M1-*` 小切片提供一份可 review 的复用边界基线：明确旧控制面每个对象在 memory-first M1 中属于 **复用 / 需改造 / 后置 / 不纳入 M1 / 保持不变** 中的哪一类，理由是什么，禁止扩展什么，以及影响哪些后续 AL-M1 任务。

本切片只记录边界与分类，**不实现任何 schema / API / 行为改动**。

## 2. Sources

- 新版 PRD revision 53：`https://bytedance.larkoffice.com/docx/HJ7gdnTcDoCx1HxCyRzcr2zyngb`（0-12 章正文 + `AL-M1-001` ~ `AL-M1-030`）。
- 旧 PRD《Agentlink 多设备 Agent 控制面 PRD》、旧 M1 技术方案《Agentlink M1 技术方案（MVP）》。
- 仓库现状（HEAD `e0c9117`）：
  - `migrations/0001_initial.sql`：`al_domain('personal','work')`、`al_task`、`al_run`、`al_run_lease`、`al_device`、`al_runner`、`al_capability_grant`、`al_workdir_grant`、`al_policy_decision`、`al_run_event`、`al_artifact`、`al_audit_log` 等。
  - `src/server.ts`：M1 HTTP API（`/api/v1/tasks`、`/api/v1/devices/*`、`/api/v1/agentlet/*`、grant/revoke 路由）。
  - `src/control-plane/`、`src/db/`、`src/domain/`、`src/agentlet/`：in-memory + PostgreSQL 控制面、领域类型、agentlet/runner skeleton。
  - `docs/m1-task-status.md`：旧 `AL-TD-*` 状态矩阵。

> 注：本文写作时仓库工作区已有未提交改动（`README.md`、`docs/m1-task-status.md` 已修改；`src/agentlet/control-plane-client.ts`、`src/agentlet/daemon.ts`、`test/agentlet-daemon.test.ts` 为未追踪文件），均来自上一切片 AL-TD-007 agentlet daemon skeleton。AL-M1-001 不动这些文件，仅新增本文件并在 `docs/m1-task-status.md` 追加 transition 小节。

## 3. Memory-first M1 target model

新版 M1 主线对象（PRD §5/§7/§8）：

```text
Entry → SourceEvent → Session → MemoryCandidate → Memory
                          │
                          └→ Task → (Main Agent 出口) → Worker
```

- **Entry / SourceEvent**：入口配置与一次性入站事件；默认不落 raw body，只留 `source_ref` / `source_hash` / `domain_hint`。
- **Session**：临时上下文沙箱；跨 session 共享记忆，不共享上下文。
- **MemoryCandidate / Memory**：M1 的长期资产；Markdown-first，复用 aria-memory / agent-dock 记忆记录形式。
- **Main Agent 出口**：把 Session/Task 路由到执行底座（旧控制面）或 Worker。

旧控制面（Task/Run/Lease/Device/Runner/Policy/Grant/Agentlet/Codex Runner）在该模型里位于 **Main Agent 出口之后的执行底座**，不再是产品主线对象。

## 4. Existing control-plane inventory

| # | 对象 / 模块 | 代码位置 | 当前角色 |
|-|-|-|-|
| 1 | Task | `al_task`、`src/server.ts` `/api/v1/tasks`、`src/domain/entities.ts:TaskRecord` | 任务创建 + 幂等 |
| 2 | Run | `al_run`、`RunRecord`、repository run 路径 | 执行实例状态机 |
| 3 | Lease | `al_run_lease`、`LeaseRecord`、`/api/v1/agentlet/lease/renew` | 单活跃租约 |
| 4 | Device | `al_device`、`DeviceRecord`、`/api/v1/devices/*` | 设备注册/鉴权/吊销 |
| 5 | Runner | `al_runner`、`RunnerRecord` | runner 能力声明 |
| 6 | Policy | `al_policy_decision`、`src/domain/policy.ts` | 静态 dispatch 策略 |
| 7 | CapabilityGrant | `al_capability_grant`、`/api/v1/devices/:id/capability-grants`、`/api/v1/capability-grants/:id/revoke` | 能力授权 |
| 8 | WorkdirGrant | `al_workdir_grant`、`/api/v1/devices/:id/workdir-grants`、`/api/v1/workdir-grants/:id/revoke` | 工作目录授权 |
| 9 | Agentlet | `src/agentlet/daemon.ts`、`src/agentlet/control-plane-client.ts`、`/api/v1/agentlet/*` | 设备侧消费循环 skeleton |
| 10 | Codex Runner | `src/agentlet/runner.ts`、`src/agentlet/codex-runner.ts` | RunnerAdapter + Codex CLI skeleton |
| 11 | PostgreSQL adapter | `src/db/*`、`src/control-plane/postgres.ts` | 持久化适配 |
| 12 | Server API | `src/server.ts` | M1 HTTP 出入口 |
| 13 | docs/m1-task-status | `docs/m1-task-status.md` | 旧 AL-TD 状态矩阵 |

## 5. Reuse classification matrix

分类定义：

- **Reuse（复用）**：M1 直接作为执行底座使用，不必改动。
- **Adjust（需改造）**：保留，但 retention / 字段 / 边界需要在后续 AL-M1 切片改造后才符合 memory-first。
- **Defer（后置）**：保留实现，但 memory-first M1 不在其上新增能力，留到 M2/M3。
- **Keep（保持不变）**：作为底座原样保留，本阶段不动。
- **Not in M1（不纳入）**：明确不在 memory-first M1 启动。

| 对象 | 分类 | 一句话理由 |
|-|-|-|
| Task | Adjust | 保留状态机，但 `payload` retention 必须改造（不存 raw message）。 |
| Run | Keep | 执行实例状态机作为底座保留。 |
| Lease | Keep | 单活跃租约作为底座保留。 |
| Device | Defer | 多设备/注册保留，但 memory-first M1 单端部署，不在其上扩展。 |
| Runner | Defer | 能力声明保留，M1 不扩展 runner 注册面。 |
| Policy | Adjust | 复用决策骨架，但 M1 记忆读写/跨域策略是新增面，需对接 memory domain。 |
| CapabilityGrant | Keep | 作为 worker 执行权限底座保留。 |
| WorkdirGrant | Keep | 作为 worker 执行权限底座保留。 |
| Agentlet | Defer | daemon skeleton 保留，M1 不做生产 daemon / 多设备 fallback。 |
| Codex Runner | Defer | 作为 Worker 示例保留，M1 不做真实 Codex E2E 主线。 |
| PostgreSQL adapter | Adjust | 复用持久化层，但需新增 memory / source_event / session 表与 retention 约束。 |
| Server API | Adjust | 复用现有路由，新增 ingress/session/memory/worker-tools 出入口。 |
| docs/m1-task-status | Adjust | 保留为 execution substrate 状态，新增 memory-first transition 说明。 |

## 6. Object-by-object boundaries

每个对象给出：分类、理由、禁止扩展项、影响的后续 AL-M1 任务。

### 6.1 Task
- 分类：**Adjust**。
- 理由：M1 仍用 Task 作为 Main Agent 出口后的执行请求；但 `al_task.payload` 可能保存 raw inbound message，与 memory-first “不长期保存全量消息”冲突。
- 禁止扩展：不得把 raw message body / full transcript 写入 `payload`；本切片不改 payload 字段。
- 影响：`AL-M1-002`（payload retention/memory_space/source_system/sensitivity 改造）、no-raw guard 相关切片。

### 6.2 Run
- 分类：**Keep**。
- 理由：执行实例状态机是底座能力，与记忆主线正交。
- 禁止扩展：M1 不在 Run 上新增 memory 语义；不把 Run 当记忆载体。
- 影响：无新增 AL-M1 主线任务；作为执行底座被 Task/Worker 间接使用。

### 6.3 Lease
- 分类：**Keep**。
- 理由：单活跃租约（`uq_al_run_lease_active`）保障并发安全，是底座不变量。
- 禁止扩展：M1 不改租约语义、不加 memory 字段。
- 影响：无。

### 6.4 Device
- 分类：**Defer**。
- 理由：memory-first M1 单端部署，不做多设备 fallback；Device 注册/鉴权/吊销保留但不演进。
- 禁止扩展：不新增多设备调度、不做设备发现、不接旧系统设备。
- 影响：后置到 M2+ 多设备/混合入口相关任务。

### 6.5 Runner
- 分类：**Defer**。
- 理由：runner 能力声明保留；M1 Worker 接入以 memory tool protocol 为主，不扩 runner 注册面。
- 禁止扩展：不新增 runner capability report 刷新 API。
- 影响：后置到 `AL-TD-WORKER-*` / M2 connector。

### 6.6 Policy
- 分类：**Adjust**。
- 理由：`src/domain/policy.ts` 决策/审计骨架可复用，但 M1 新增的是 memory 读写、跨域、worker scope 策略面，与现有 dispatch policy 不同。
- 禁止扩展：本切片不实现 memory policy；只标记其为后续新增面，避免与现有 dispatch policy 混淆。
- 影响：`AL-TD-MEM-004`（memory write policy/approval）、`AL-TD-WORKER-001`（scope token）。

### 6.7 CapabilityGrant
- 分类：**Keep**。
- 理由：作为 worker 执行权限底座，与 memory scope 解耦。
- 禁止扩展：M1 不把 capability grant 当 memory 访问控制。
- 影响：无；memory scope 由独立 worker scope token 负责。

### 6.8 WorkdirGrant
- 分类：**Keep**。
- 理由：工作目录授权是设备执行权限，底座保留。
- 禁止扩展：不扩展为 memory path scope。
- 影响：无。

### 6.9 Agentlet
- 分类：**Defer**。
- 理由：`AgentletDaemon` 是可注入的消费循环 skeleton，可作为底座；但 M1 不做生产常驻 daemon / orphan 进程管理 / 多设备 fallback。
- 禁止扩展：不实现持久 daemon main loop、不做生产部署。
- 影响：后置到底座 hardening（非 memory-first M1 主线）。

### 6.10 Codex Runner
- 分类：**Defer**。
- 理由：`RunnerAdapter` + Codex CLI skeleton 作为 Worker 示例保留；Telegram→claw-tenc→Codex E2E 不再是 M1 主线。
- 禁止扩展：不做真实 Codex CLI 设备 smoke 主线、不做 Telegram E2E。
- 影响：`AL-TD-WORKER-004`（Codex worker integration，M2）。

### 6.11 PostgreSQL adapter
- 分类：**Adjust**。
- 理由：`SqlClient` / repository / runtime 持久化层可复用；但需新增 memory / source_event / session 表与 retention/redaction 约束。
- 禁止扩展：本切片不加表、不改 SQL contract。
- 影响：`AL-M1-002`、`AL-TD-MEM-001`（memory schema）、`AL-TD-INGRESS-001`（Entry/SourceEvent model）。

### 6.12 Server API
- 分类：**Adjust**。
- 理由：现有路由保留为执行底座出入口；memory-first M1 需新增 ingress/session/memory/worker-tools 路由。
- 禁止扩展：本切片不加路由、不改 DTO。
- 影响：`AL-TD-INGRESS-*`、`AL-TD-MEM-002`、`AL-TD-WORKER-002`。

### 6.13 docs/m1-task-status
- 分类：**Adjust**。
- 理由：旧 AL-TD 矩阵反映的是 execution substrate 完成度，不代表新版 PRD memory-first 主线完成度。
- 禁止扩展：不删除旧矩阵；只追加 transition 小节并链接本文。
- 影响：所有 AL-M1 切片的进度阅读口径。

## 7. What M1 must not start

memory-first M1 **明确不启动**以下内容（PRD §3.3 非目标 + 用户多轮口径修正）：

1. **MemoryBridge**：跨实例/跨语境/跨隔离边界的记忆流动机制，M1 只用本实例本地记忆，仅预留 `source_system / memory_space / bridge_status` 等字段。
2. **work/personal 记忆互通**：M1 单端部署，不实现跨域记忆流动/同步。
3. **历史系统导入**：aria-memory / AgentDock / happyclaw 记忆与会话摘要导入是 M2+ 的 import PoC，不进入 M1。
4. **AgentDock / happyclaw / Keyclaw / Hermes runtime 接入**：不纳管其 workspace / session / runner / 服务生命周期；M1 直接不做旧系统接入。
5. **多 MainUser**：M1 只设计单一 main user；普通用户通过消息渠道 @bot 交互是后续能力。
6. **Telegram 主线 E2E**：Telegram→claw-tenc→Codex 降级为执行层验证用例，不是 M1 产品主线。
7. **生产 daemon / 多设备 fallback**：不做常驻 daemon main loop、orphan 进程管理、多设备故障转移。

## 8. Coder scope for AL-M1-001

本切片（docs-only）允许且仅允许：

- 新增 `docs/m1-control-plane-reuse-boundary.md`（本文）。
- 更新 `docs/m1-task-status.md`：新增 memory-first M1 transition 小节，链接本文，说明旧 AL-TD 矩阵是 execution substrate 状态。

本切片**禁止**：

- 修改 `src/**`、`migrations/**`、`test/**`、`package.json`、`package-lock.json`。
- 把已有未提交的 README / agentlet daemon 改动混入本切片。
- commit / push。

## 9. Acceptance criteria

- `docs/m1-control-plane-reuse-boundary.md` 存在，且覆盖第 4 节清单全部 13 个对象。
- 每个对象有：分类、理由、禁止扩展项、影响的 AL-M1 后续任务。
- 第 7 节列出全部 M1 禁止启动项。
- `docs/m1-task-status.md` 含 memory-first M1 transition 小节并链接本文。
- `git diff --check` 通过；变更仅限上述两个 docs 文件（外加本切片前已存在的未提交改动，不由本切片引入）。

## 10. Review checklist

- [ ] 分类矩阵与逐对象边界一致，无对象遗漏。
- [ ] 每个 Adjust/Defer 对象都指明了禁止扩展项。
- [ ] M1 禁止启动项与 PRD §3.3 非目标 + 用户最新口径一致（含 AgentDock/happyclaw/Keyclaw/Hermes、MemoryBridge、多 MainUser）。
- [ ] 仓库事实引用正确（`al_domain` 仍为 `personal/work`；四表确实存在）。
- [ ] 本切片未改 `src/**` / `migrations/**` / `test/**`。
- [ ] 未提交、未推送。

## 11. Risks / open questions

- **R1**：旧矩阵口径混淆风险。读者可能把 `AL-TD-*` 的 Partial/Done 误读为 memory-first 主线进度；已在 §6.13 与 `docs/m1-task-status.md` transition 小节显式声明区分。
- **R2**：`al_domain` 二值与 PRD 记忆域模型的映射尚未定稿（PRD 多轮修正后倾向 scope/context/policy 维度，而非固定 work/personal 两类）；本切片不决策，留给 `AL-M1-002` / `AL-TD-MEM-001`。
- **R3**：retention/redaction 改造（payload/event/artifact/audit）跨多个对象，需保证执行底座行为不被 memory-first 约束破坏；本切片只标边界，实际改造在后续切片需配 no-raw guard 测试。
- **R4**：工作区在本切片前已有未提交改动（AL-TD-007 agentlet daemon skeleton）。若后续误把它们与 AL-M1-001 一起提交，会污染切片边界；提交前需按 §8 范围核对。
- **OQ1**：Entry/SourceEvent/Session/Memory 是否复用现有 `al_*` 命名前缀与 PostgreSQL，还是 Markdown-first 单独存储，待 `AL-TD-INGRESS-001` / `AL-TD-MEM-001` 决策。
