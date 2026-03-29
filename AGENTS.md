# HappyPaw — AGENTS.md

本文档是本仓库面向 Coding Agent 的单一工程指南，整合了项目背景、架构地图、运行时约束、代码组织规则、变更边界与验证要求。

## 1. 核心目标

HappyPaw 是一个自托管的多用户 AI Agent 系统，当前产品面只支持 Codex。

- **输入渠道**：飞书 / Telegram / QQ / 微信 / Web
- **执行方式**：Docker 容器或宿主机进程中的固定版本 Codex
- **输出方式**：IM 消息、Web 实时流式推送、终端与系统状态面板
- **持久记忆**：Agent 自主维护工作区 `AGENTS.md` 与其他文件，实现跨会话持久化

Agent 在没有额外说明时，应优先选择最直接、边界最清晰、影响范围最容易验证的实现方式，并始终遵循：`可预测`、`可定位`、`可修改`、`可验证`。

## 2. 不可违背的总原则

- **Codex-only**：不要重新引入 Claude 时代的支持面、路径语义或文案。
- **会话隔离**：每个会话拥有独立工作目录、`.codex` 运行目录与 IPC 命名空间。
- **用户隔离**：member 不能访问其他用户的工作区、全局记忆、MCP/任务控制面。
- **不丢消息、不重复回复、失败可重试**：修改容器、调度、消息路由时优先守住这些行为。
- **源文件优先**：不要修改 `dist/`、`generated/`、构建输出代替修改源码。
- **先理解现有模式再改**：新实现优先复用已使用的库、目录结构、命名方式和调用链。
- **完成后必须验证**：修改结束后必须运行对应的 typecheck / test / lint / build 验证。

## 3. 项目架构总览

### 3.1 后端模块

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 启动入口：管理员引导、消息轮询、IPC 监听、容器生命周期 |
| `src/web.ts` | Hono 路由挂载、WebSocket 升级、静态文件托管、Cookie 认证 |
| `src/routes/auth.ts` | 登录 / 注册 / 登出 / setup / profile / change-password |
| `src/routes/groups.ts` | 群组 CRUD、消息分页、会话重置、群组级 env |
| `src/routes/files.ts` | 文件上传/下载/删除、目录管理、路径遍历防护 |
| `src/routes/config.ts` | Codex、系统设置、per-user IM 配置路由注册 |
| `src/routes/monitor.ts` | 系统状态、队列状态、健康检查 |
| `src/routes/memory.ts` | 记忆文件读写、主记忆映射、全文检索 |
| `src/routes/tasks.ts` | 定时任务 CRUD 与执行日志 |
| `src/routes/skills.ts` | Skills 列表、安装、同步与管理 |
| `src/routes/admin.ts` | 用户管理、邀请码、审计日志、注册设置 |
| `src/routes/browse.ts` | 目录浏览与受白名单限制的工作目录创建 |
| `src/routes/agents.ts` | Sub-Agent CRUD |
| `src/routes/mcp-servers.ts` | MCP Servers CRUD 与宿主机同步 |
| `src/feishu.ts` | 飞书连接工厂、去重、富文本卡片、文件下载 |
| `src/telegram.ts` | Telegram Long Polling、HTML 渲染、图片/文件处理 |
| `src/qq.ts` | QQ WebSocket、OAuth Token、图片下载与群聊 @Bot |
| `src/wechat.ts` | 微信接入与消息桥接 |
| `src/im-downloader.ts` | IM 下载文件落盘与 50MB 限制处理 |
| `src/im-manager.ts` | per-user IM 连接池、热重连、批量断开 |
| `src/container-runner.ts` | 容器/宿主机进程启动、挂载构建、环境变量注入 |
| `src/agent-output-parser.ts` | OUTPUT_MARKER 解析、stdout/stderr 处理 |
| `src/group-queue.ts` | 容器/宿主机进程并发控制、重试与排队 |
| `src/runtime-config.ts` | 配置读写导出层 |
| `src/task-scheduler.ts` | cron / interval / once 调度 |
| `src/file-manager.ts` | 路径安全、符号链接检测、系统路径保护 |
| `src/mount-security.ts` | 挂载白名单/黑名单校验、只读强制 |
| `src/db.ts` | SQLite 数据层、schema 迁移入口 |
| `src/auth.ts` | 密码哈希、会话 token、用户名/密码校验 |
| `src/permissions.ts` | 权限定义与模板 |
| `src/schemas.ts` | Zod v4 请求体校验 |
| `src/utils.ts` | 通用工具函数（如 `getClientIp()`） |
| `src/web-context.ts` | Web 依赖注入、群组访问控制、WS 客户端管理 |
| `src/middleware/auth.ts` | Cookie Session 校验与权限中间件 |
| `src/im-channel.ts` | 统一 IM 通道接口 |
| `src/commands.ts` | Web 侧斜杠命令处理（如 `/clear`） |
| `src/im-command-utils.ts` | IM 斜杠命令纯函数工具，便于测试 |
| `src/telegram-pairing.ts` | Telegram 配对码工具 |
| `src/terminal-manager.ts` | 容器终端（node-pty + fallback） |
| `src/message-attachments.ts` | 图片附件规范化 |
| `src/image-detector.ts` | 图片 MIME 检测（由 `shared/` 同步） |
| `src/daily-summary.ts` | 每日对话汇总写入 `HEARTBEAT.md` |
| `src/script-runner.ts` | 脚本任务执行器 |
| `src/reset-admin.ts` | 管理员密码重置脚本 |
| `src/config.ts` | 路径、超时、并发限制等常量 |
| `src/logger.ts` | pino / pino-pretty 日志 |

### 3.2 前端技术栈

| 层次 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript + Vite 6 |
| 状态 | Zustand 5 |
| 路由 | React Router 7 |
| 样式 | Tailwind CSS 4 |
| 通信 | 统一 API client + WebSocket |
| 渲染 | react-markdown + mermaid + rehype-highlight |
| UI | radix-ui + lucide-react |
| PWA | vite-plugin-pwa |

### 3.3 前端主要页面

| 路径 | 页面 | 权限 |
|------|------|------|
| `/setup` | `SetupPage` | 未初始化时公开 |
| `/setup/providers` | `SetupProvidersPage` | 登录后 |
| `/setup/channels` | `SetupChannelsPage` | 登录后 |
| `/login` | `LoginPage` | 公开 |
| `/register` | `RegisterPage` | 公开（可关闭） |
| `/chat/:groupFolder?` | `ChatPage` | 登录后 |
| `/tasks` | `TasksPage` | 登录后 |
| `/monitor` | `MonitorPage` | 登录后 |
| `/memory` | `MemoryPage` | 登录后 |
| `/skills` | `SkillsPage` | 登录后 |
| `/settings` | `SettingsPage` | 登录后 |
| `/mcp-servers` | `McpServersPage` | 登录后 |
| `/users` | `UsersPage` | 指定管理权限 |

### 3.4 Agent Runner

`container/agent-runner/` 负责容器/宿主机里的 Codex 对话执行。

- stdin 接收 `ContainerInput`
- stdout 输出 `OUTPUT_START_MARKER...OUTPUT_END_MARKER` 包裹的 `ContainerOutput`
- 流式事件通过 WebSocket `stream_event` 广播
- 预定义 Sub-Agent：`code-reviewer`、`web-researcher`
- 内置 HappyPaw MCP bridge，提供 `send_message`、`schedule_task`、`memory_*` 等工具
- PreCompact Hook 会在上下文压缩前归档对话到 `conversations/`

### 3.5 执行模式

| 模式 | 行为 | 适用对象 | 依赖 |
|------|------|---------|------|
| `host` | 宿主机进程执行，直接访问宿主机文件系统 | admin 主容器（`main`） | Node.js |
| `container` | Docker 容器执行，卷挂载隔离文件 | member 主容器及其他群组 | Docker Desktop |

`is_home=true` 的主容器在注册时自动创建：
- admin：`folder=main`，模式=`host`
- member：`folder=home-{userId}`，模式=`container`

## 4. 数据流与协议

### 4.1 消息流

```text
飞书/Telegram/QQ/微信/Web 消息
→ storeMessageDirect(db) + broadcastNewMessage(ws)
→ index.ts 轮询 getNewMessages()
→ queue.enqueueMessageCheck()
   ├── 空闲：runContainerAgent()
   ├── 运行中：queue.sendMessage() 通过 IPC 注入
   └── 满载：waitingGroups 排队
→ 流式输出 onOutput
→ IM 回复 / Web 广播 / DB 存储
```

### 4.2 流式事件链路

```text
Codex App Server
→ text_delta / tool_use_start / ...
→ agent-runner 缓冲与标准化
→ container-runner 解析 marker 输出
→ WebSocket `stream_event`
→ 前端 chat store `handleStreamEvent()`
```

### 4.3 IPC 目录

| 方向 | 路径 | 用途 |
|------|------|------|
| 主进程 → 容器 | `data/ipc/{folder}/input/*.json` | 注入消息 |
| 主进程 → 容器 | `data/ipc/{folder}/input/_close` | 优雅关闭 |
| 容器 → 主进程 | `data/ipc/{folder}/messages/*.json` | `send_message` 输出 |
| 容器 → 主进程 | `data/ipc/{folder}/tasks/*.json` | 任务管理 |

文件写入必须保持原子性：先写 `.tmp`，再 `rename`。

### 4.4 容器挂载策略

| 资源 | 容器路径 | admin 主容器 | member 主容器 / 其他 |
|------|---------|-------------|----------------------|
| `data/groups/{folder}/` | `/workspace/group` | 读写 | 读写（仅自己） |
| 项目根目录 | `/workspace/project` | 读写 | 不可访问 |
| `data/groups/user-global/{userId}/` | `/workspace/global` | 读写 | 读写（仅自己） |
| `data/sessions/{folder}/.codex/` | `/home/node/.codex` | 读写 | 读写（仅自己） |
| `data/ipc/{folder}/` | `/workspace/ipc` | 读写 | 读写（仅自己） |
| `container/skills/` | `/workspace/project-skills` | 只读 | 只读 |
| `~/.codex/skills/` | `/workspace/user-skills` | 只读 | admin 创建的会话可读 |
| `data/env/{folder}/env` | `/workspace/env-dir/env` | 只读 | 只读 |
| 白名单额外挂载 | `/workspace/extra/{name}` | 按白名单 | `nonMainReadOnly` 时强制只读 |

### 4.5 环境变量优先级

1. 进程环境变量
2. 全局 Codex 配置 `data/config/codex-provider.json`
3. 默认接入参数 / 自定义环境变量
4. 群组级覆盖 `data/config/container-env/{folder}.json`

## 5. 用户、权限与隔离模型

### 5.1 认证机制

- bcrypt 12 轮密码哈希
- 30 天 Cookie Session
- HMAC 签名，`HttpOnly` + `SameSite=Lax`
- `data/config/session-secret.key` 持久化会话密钥（0600）
- 登录失败锁定：默认 5 次 / 15 分钟

### 5.2 RBAC

角色：`admin`、`member`

权限：
- `manage_system_config`
- `manage_group_env`
- `manage_users`
- `manage_invites`
- `view_audit_log`

模板：`admin_full`、`member_basic`、`ops_manager`、`user_admin`

### 5.3 用户隔离

| 资源 | admin | member |
|------|-------|--------|
| 主容器 folder | `main` | `home-{userId}` |
| 执行模式 | `host` | `container` |
| 项目根目录挂载 | 可读写 | 不可访问 |
| 用户级全局记忆 | 可读写 | 仅自己 |
| IM 通道 | 独立配置 | 独立配置 |
| Web 终端 | 可访问自己的终端 | 可访问自己的终端 |
| 跨组 MCP / 任务控制 | admin 主容器可跨组 | 仅自己的群组 |

### 5.4 审计事件

`AuthEventType` 包括：
`login_success`、`login_failed`、`logout`、`password_changed`、`profile_updated`、`user_created`、`user_disabled`、`user_enabled`、`user_deleted`、`user_restored`、`user_updated`、`role_changed`、`session_revoked`、`invite_created`、`invite_deleted`、`invite_used`、`recovery_reset`、`register_success`。

## 6. 数据模型与目录约定

### 6.1 核心数据库表

| 表 | 主键 | 用途 |
|----|------|------|
| `chats` | `jid` | 群组元数据 |
| `messages` | `(id, chat_jid)` | 消息历史 |
| `scheduled_tasks` | `id` | 定时任务 |
| `task_run_logs` | `id` | 任务执行日志 |
| `registered_groups` | `jid` | 注册工作区 / 主容器映射 |
| `sessions` | `(group_folder, agent_id)` | Codex session/thread 映射 |
| `router_state` | `key` | 各类游标状态 |
| `users` | `id` | 用户与外观配置 |
| `user_sessions` | `id` | 登录会话 |
| `invite_codes` | `code` | 邀请码 |
| `auth_audit_log` | `id` | 审计日志 |
| `group_members` | `(group_folder, user_id)` | 共享工作区成员关系 |
| `agents` | `id` | Sub-Agent |
| `usage_records` | `id` | Token 用量明细 |
| `usage_daily_summary` | `(user_id, model, date)` | 日聚合用量 |
| `user_quotas` | `user_id` | 预留配额表 |

### 6.2 运行时目录

```text
data/
  db/messages.db
  groups/{folder}/
  groups/{folder}/AGENTS.md
  groups/{folder}/logs/
  groups/{folder}/conversations/
  groups/{folder}/downloads/{channel}/
  groups/user-global/{userId}/
  groups/user-global/{userId}/AGENTS.md
  sessions/{folder}/.codex/
  ipc/{folder}/input/
  ipc/{folder}/messages/
  ipc/{folder}/tasks/
  env/{folder}/env
  memory/{folder}/
  config/
  config/codex-provider.json
  config/container-env/{folder}.json
  config/user-im/{userId}/{channel}.json
  config/registration.json
  config/session-secret.key
  config/system-settings.json
  streaming-buffer/
  skills/{userId}/
  mcp-servers/{userId}/servers.json

config/default-groups.json
config/mount-allowlist.json
config/global-agents-md.template.md
container/skills/
shared/
scripts/
```

### 6.3 系统保护路径

文件 API 不允许直接操作这些系统路径：
- `logs/`
- `AGENTS.md`
- `.codex/`
- `conversations/`

## 7. 外部接口与行为面

### 7.1 Web API 重点面

- 认证：`/api/auth/*`
- 群组：`/api/groups*`
- 文件：`/api/groups/:jid/files*`
- 记忆：`/api/memory/*`
- 配置：`/api/config/*`、`/api/config/user-im/*`
- 任务：`/api/tasks*`
- 管理：`/api/admin/*`
- Sub-Agent：`/api/groups/:jid/agents*`
- 目录浏览：`/api/browse/directories`
- MCP Servers：`/api/mcp-servers*`
- 用量：`/api/usage/*`
- 监控：`/api/status`、`/api/health`
- WebSocket：`/ws`

### 7.2 关键产品行为

#### 设置向导
- 首次启动无用户时，`GET /api/auth/status` 返回 `initialized: false`
- 前端跳转 `/setup` 创建首个管理员
- 完成后进入 `/setup/providers`
- 新注册用户进入 `/setup/channels`

#### IM 自动注册
- 未注册会话首次发消息时，自动注册到用户主容器
- admin 主容器为 `main`
- member 主容器为 `home-{userId}`
- QQ 通道需要先配对码绑定

#### 会话隔离
- 每个会话独立工作区、`.codex`、IPC 目录
- 非主会话只能发消息给自己所在群组

#### 主容器权限层级
- 所有主容器都有 `memory_search` / `memory_get` / `memory_append`
- admin 主容器额外拥有项目根目录读写、跨会话 IPC、跨组任务控制、`register_group`

#### 回复路由
- 主容器在 Web 与 IM 共用历史
- IM 消息回复回原渠道
- Web 消息仅在 Web 展示

#### 并发控制
- 最多 20 个并发容器
- 最多 5 个并发宿主机进程
- 任务优先于普通消息
- 指数退避重试：5s → 10s → 20s → 40s → 80s，最多 5 次

#### Per-user AI 外观
- 用户可自定义 `ai_name`、`ai_avatar_emoji`、`ai_avatar_color`
- 前端按群组 owner 渲染 AI 外观

#### IM 通道热更新
- 更新配置后立即断开旧连接、尝试新连接
- `ignoreMessagesBefore` 防止处理积压消息
- 微信额外支持二维码绑定与断开

#### IM 斜杠命令
- `/list` `/ls`
- `/status`
- `/where`
- `/bind <workspace>`
- `/unbind`
- `/new <名称>`
- `/clear`
- `/require_mention true|false`
- `/recall` / `/rc` 已移除，只返回 Codex-only 提示

#### 飞书群聊 mention 控制
- `require_mention=false`：群聊全量响应
- `require_mention=true`：只有 @机器人 时响应
- 私聊始终响应

## 8. 工程组织与命名规则

### 8.1 目录组织

- 业务代码优先按功能域组织
- 公共代码放入明确共享目录，不能把 `shared/` 当杂物箱
- 脚本、配置、测试、生成产物分开存放
- 新文件优先放到所属功能附近

推荐结构：

```text
src/
  features/
    <feature-name>/
  shared/
    components/
    utils/
    types/
tests/
scripts/
configs/
generated/
output/
```

### 8.2 命名规则

- 目录名：`kebab-case`
- React 组件：`PascalCase`
- 普通模块：`kebab-case`
- 类型文件：`*.types.ts`
- 测试文件：统一放在 `tests/`，保持镜像布局

### 8.3 单文件约束

- 单文件只承载单一职责
- 不要把 UI、数据请求、类型、测试辅助逻辑混在一个大文件
- 单文件原则上不超过 2000 行
- 若接近上限，优先按职责拆分

### 8.4 模块边界

- 每个 feature 应有明确入口
- 对外暴露内容集中在 `index.ts` 或专门导出文件
- 不直接跨目录依赖内部实现
- 避免循环依赖

### 8.5 共享代码规则

只有同时满足以下条件，才放进共享目录：
- 被多个功能复用
- 不依赖某个 feature 的私有状态
- 职责和命名都足够清晰

### 8.6 反模式

避免：
- 新建 `misc`、`temp`、`common` 等模糊目录
- 持续向单个 `utils.ts` 叠加无关函数
- 跨 feature 直接引用内部实现
- 修改生成产物替代修改源码
- 未验证即结束任务

## 9. 开发与变更约束

### 9.1 修改前后的默认决策

当需求没有明确指定实现位置时，按以下优先级：
1. 先找现有 feature 并原位修改
2. 若是该 feature 的新能力，仍放在该 feature 内
3. 若被多个 feature 复用，再抽到共享层
4. 若属于脚本或工具链，放入 `scripts/` 或配置目录
5. 若只是分析结果，放入临时目录，不混入业务源码

### 9.2 提交与评审规范

- **Git commit message 必须使用英文并遵循 Conventional Commits 1.0.0 规范**：`<type>[optional scope]: <description>`
- 推荐使用小写类型，如：`feat`、`fix`、`refactor`、`docs`、`test`、`chore`
- 涉及破坏性变更时，必须使用 `!` 或 `BREAKING CHANGE:` 脚注显式标记
- PR 标题与 commit message 一致
- Issue 标题使用小写英文前缀：`bug:` / `feat:` / `perf:`

Bug 类 Issue 推荐正文结构：

```markdown
## 用户现象
## 问题描述
## 复现路径
## 根因（可选）
## 影响
## 建议修复（可选）
```

### 9.3 运行与系统约束

- 不要重新引入“触发词”架构
- StreamEvent 类型只以 `shared/stream-event.ts` 为单一真相源
- 新增/修改 StreamEvent 后必须运行 `make sync-types`
- 容器内以 `node` 非 root 用户运行，注意权限问题
- 关闭服务时禁止 `lsof -ti:PORT | xargs kill`
- 正确做法：`lsof -ti:PORT -sTCP:LISTEN | xargs kill`

## 10. 验证与本地开发

### 10.1 常用命令

```bash
make dev
make dev-backend
make dev-web
make build
make start
make typecheck
make format
make install
make clean
make sync-types
make reset-init
make backup
make restore
make help
```

### 10.2 端口

- 后端：`3000`
- 前端开发服务器：`5173`

### 10.3 三个独立 Node 项目

| 项目 | 目录 | 用途 |
|------|------|------|
| 主服务 | `/` | 后端服务 |
| Web 前端 | `web/` | React SPA |
| Agent Runner | `container/agent-runner/` | 执行引擎 |

### 10.4 验证要求

每次改动都必须按范围运行验证：
- 单元测试
- 类型检查
- lint / format check
- 必要时构建验证

如无更精确范围，优先从下列命令中选择：

```bash
make typecheck
make format-check
npm run build
npm --prefix container/agent-runner run build
node tests/<affected-test>.mjs
```

## 11. 高频改动指引

### 11.1 新增 Web 设置项
1. 在对应 `src/routes/*.ts` 增加鉴权 API
2. 持久化写入 `data/config/*.json`
3. 前端 `SettingsPage` 增加表单

### 11.2 将环境变量迁移为 Web 可配置
1. 在 `runtime-config.ts` / system settings 类型中增加字段
2. 实现 file → env → default 三级回退
3. 在保存逻辑加入范围校验
4. 在 `schemas.ts` 中增加 Zod 校验
5. 更新前端设置项字段数组

### 11.3 新增会话级功能
1. 明确是否需要容器隔离
2. 明确是否写入会话私有目录
3. 同步更新 Web API 与前端 store

### 11.4 新增 MCP 工具
1. 在 `container/agent-runner/src/mcp-tools.ts` 新增 `tool()` 定义
2. 在 `src/index.ts` 增加 IPC 分支处理
3. 重建容器镜像：`./container/build.sh`

### 11.5 新增 Skills
1. 项目级：放入 `container/skills/`
2. 用户级：放入 `~/.codex/skills/`
3. 一般无需重建镜像，挂载 + entrypoint 自动发现即可

### 11.6 新增 StreamEvent 类型
1. 修改 `shared/stream-event.ts`
2. 运行 `make sync-types`
3. 更新 `container/agent-runner/src/stream-processor.ts`
4. 更新前端 chat store 的处理逻辑

### 11.7 新增 IM 集成渠道
1. 新建连接工厂模块（参考 `feishu.ts`、`telegram.ts`、`qq.ts`、`wechat.ts`）
2. 在 `src/im-manager.ts` 中接入 `connectUser{Channel}` / `disconnectUser{Channel}`
3. 在配置路由中增加 `/api/config/user-im/{channel}`
4. 在 `src/index.ts` 启动流程中加载新渠道
5. 更新设置页与 setup 引导页面

### 11.8 修改数据库 Schema
1. 在 `src/db.ts` 新增 migration
2. 更新 `SCHEMA_VERSION`
3. 同步更新建表 SQL 与迁移 SQL

## 12. 最终自检标准

如果一个新加入的 Agent 能在短时间内回答下面问题，说明本指南足够清晰：

1. 项目入口在哪
2. 某个功能应该改哪个目录
3. 公共代码该放哪
4. 测试在哪里
5. 改完运行什么验证命令
6. 哪些路径与运行时语义不能破坏

如果做不到，就继续收紧结构、边界、命名和验证约束。
