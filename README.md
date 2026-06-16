# Agentlink

Agentlink 是一个面向个人多设备 AI 工作流的轻量控制面。它把用户入口、任务状态、设备能力、租约调度和执行结果汇报放到一个清晰的中心层里，同时把真正的执行权和凭据留在设备侧 agentlet。

当前 M1 目标是跑通一个最小个人闭环：

```text
Telegram -> Agentlink Control Plane -> claw-tenc Agentlet -> Codex CLI -> Telegram
```

## 为什么做 Agentlink

个人 AI 工作流经常跨多台设备、多种 runner、多套网络环境和多个消息入口。Agentlink 的目标不是替代这些工具，而是提供一个小而明确的控制面：

- 统一创建和追踪 Task / Run；
- 注册设备、runner、capability 和 workdir grant；
- 通过 lease 把任务安全地下发给设备侧 agentlet；
- 让 agentlet 主动 pull / renew / recover，避免设备暴露公网入口；
- 回收 progress、artifact 和 final result；
- 保持 runner 凭据、代码目录和本地执行权限只留在设备上。

## 核心概念

- **Task**：用户层请求，通常来自 Telegram 或 API。
- **Run**：一次具体执行 attempt，包含 retry 信息。
- **Lease**：一个有时效的执行租约，保证同一 Run 同时只被一个 agentlet 执行。
- **Device**：可信设备，例如 M1 的 `claw-tenc`。
- **Agentlet**：设备侧常驻进程，负责拉取任务、续租、恢复、执行和上报。
- **Runner**：本地执行后端，M1 首个 runner 是 Codex CLI。
- **Control Action**：控制面下发给 agentlet 的控制指令，例如 `cancel_run`。

## 当前状态

Agentlink 仍处于 M1 开发阶段，当前仓库已经包含：

- Node.js 22 + TypeScript 控制面骨架；
- Task / Run / Lease / Device 的最小 HTTP API；
- in-memory control plane，用于协议级测试；
- PostgreSQL schema、SQL contract、repository adapter 和 `pg` runtime adapter；
- 可选 PostgreSQL-backed server mode：`AGENTLINK_STORAGE=postgres`；
- `db:smoke` 在真实 PostgreSQL DSN 下会创建临时 schema，验证 migration、active lease 唯一约束、并发 skip locked、renew/recover/control action 等关键合同；
- 静态 capability grant / workdir grant 派发前校验，以及最小 grant 管理 API；
- agentlet `pull` / `ack` / `lease/renew` / `control/poll` / `control/ack` / `recover` / `recover/decision` / `progress` / `complete` 的协议骨架；
- device revoke cascade：吊销设备 token，并取消该设备当前 active lease / in-flight run；
- agentlet 侧 RunnerAdapter 本地执行契约，以及 Codex CLI Adapter 的最小骨架（命令构造、workspace 边界、stdout/stderr progress 映射、cancel/timeout 边界）；
- GitHub Actions CI 和 Node 内置测试。

还未包含：

- CI 中固定运行的真实 PostgreSQL DSN 环境和更完整的故障注入 / 并发压力测试；
- 常驻 agentlet daemon，以及把 control-plane pull/ack/renew/progress/complete 串到本地 runner 的消费循环；
- Codex Runner Adapter 的真实设备侧 smoke / 长任务恢复 / 进程清理验证；
- Telegram Adapter；
- 生产部署配置和端到端 E2E。

因此当前项目还不能作为可用产品部署，只能作为 M1 控制面与协议骨架继续迭代。

## 快速开始

```bash
npm ci
npm run check
npm start
```

默认启动 in-memory 模式，适合本地协议 smoke test。

基础端点：

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/meta`

M1 控制面当前还包含最小设备管理接口：

- `GET/POST /api/v1/devices/:device_id/capability-grants`
- `POST /api/v1/capability-grants/:grant_id/revoke`
- `GET/POST /api/v1/devices/:device_id/workdir-grants`
- `POST /api/v1/workdir-grants/:grant_id/revoke`
- `POST /api/v1/devices/:device_id/revoke`

## PostgreSQL

运行 PostgreSQL smoke test：

```bash
AGENTLINK_DATABASE_URL=postgres://... npm run db:smoke
```

未设置 `AGENTLINK_DATABASE_URL` 时，`db:smoke` 会按设计跳过并返回成功。设置后，脚本会在临时 schema 中应用 migration，并验证核心 PostgreSQL 合同：

- active lease partial unique index；
- `FOR UPDATE SKIP LOCKED` 下的并发领取行为；
- `lease/renew` 与 `recoverContinue` 只能在 `ACKED/RENEWED + RUNNING` 上成功；
- `recoverDiscard` 可以清理 active lease；
- control action 的 poll / ack 基础路径。

启用 PostgreSQL-backed server mode：

```bash
AGENTLINK_STORAGE=postgres \
AGENTLINK_DATABASE_URL=postgres://... \
npm start
```

默认仍是：

```bash
AGENTLINK_STORAGE=memory
```

## 部署脚本

`scripts/deploy.sh` 是一个最小、可审计的部署 helper，用于在 devbox/server 上拉起 Agentlink。它**不是** Docker/systemd/PM2 进程管理器，只会在前台 `exec npm start`。

```bash
# 校验配置 + 安装/构建/检查/db:smoke，但不启动服务
npm run deploy:check        # 等价于 scripts/deploy.sh check

# 校验、构建后前台启动（exec npm start）
npm run deploy              # 等价于 scripts/deploy.sh start

# 只打印将执行的启动命令与脱敏配置摘要，不做任何安装/构建/启动
scripts/deploy.sh print-command     # 或 scripts/deploy.sh --dry-run
scripts/deploy.sh --help
```

模式：

- `start`（默认）：加载可选 env 文件 → 校验配置 → `npm ci` / `npm run build` / `npm run check` / `npm run db:smoke` → `exec npm start`。
- `check`（别名 `prepare`）：同上但**不启动服务**，适合 CI/预检。
- `print-command`（别名 `dry-run` / `--dry-run`）：只打印启动命令和脱敏配置摘要。

env 文件：默认加载仓库根目录 `.env`（存在时），可用 `AGENTLINK_ENV_FILE` 或 `--env-file PATH` 指定。

devbox / memory 用法（默认）：

```bash
AGENTLINK_STORAGE=memory npm run deploy
```

postgres / production 用法：

```bash
NODE_ENV=production \
AGENTLINK_STORAGE=postgres \
AGENTLINK_DATABASE_URL=postgres://... \
AGENTLINK_SOURCE_HASH_SECRET=... \
AGENTLINK_INGRESS_BEARER_TOKEN=... \
npm run deploy
```

必须的环境校验：

- Node.js >= 22；
- `AGENTLINK_STORAGE=postgres` 时必须有 `AGENTLINK_DATABASE_URL`；
- `NODE_ENV=production` 时必须有 `AGENTLINK_SOURCE_HASH_SECRET` 和 `AGENTLINK_INGRESS_BEARER_TOKEN`。

Health check：服务启动后可探测 `GET /healthz` 与 `GET /readyz`。

限制与安全边界：

- 不是 Docker/systemd/PM2，不做进程守护、重启或多实例编排；
- 日志中**不会**输出 token / secret / database URL 的明文（仅显示 `set (redacted)` 或 `(unset)`）；
- **不会自动迁移业务数据库**。默认只跑 `db:smoke`（临时 schema）。如需脚本应用 `migrations/0001_initial.sql`，必须显式设置 `AGENTLINK_DEPLOY_APPLY_MIGRATION=1`（要求安装 `psql` 且配置 `AGENTLINK_DATABASE_URL`）——这会直接对目标库执行 migration，请谨慎使用，更推荐手动执行迁移。

## 开发命令

```bash
npm run typecheck
npm test
npm run build
npm run db:smoke
npm audit --omit=dev
```

## 设计边界

M1 只做 personal domain 的最小闭环，不接管所有个人设备，也不接入 work domain。当前优先级是让 `claw-tenc + Codex CLI` 跑通稳定闭环，再逐步接入 Telegram、更多 runner 和更多设备。Codex CLI Adapter 当前只是可测试骨架，凭据仍留在设备本地环境中，控制面和数据库不保存 runner 凭据。

## License

Agentlink 使用 MIT License，详见 [LICENSE](./LICENSE)。
