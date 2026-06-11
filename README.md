# Neros

Neros 是一个基于 TypeScript、Node.js、Ink 和 OpenAI Compatible API 的 TUI Agent。第一阶段目标是做出可通过 `npx` 启动的全屏 Terminal UI，支持聊天窗口、流式输出、Tool 日志和 DeepSeek 接入；同时将 Agent Core 与 UI 层彻底解耦，方便后续扩展到 Web、Desktop(Tauri) 和 HarmonyOS。

## 设计参考

本项目初期参考以下两个本地代码库的架构思路，但不直接绑定它们的实现：

- `/Users/wzc/studyspace/cc/Claude-Code-rev`
  - CLI 入口采用快速路径和动态加载，避免启动时加载整个应用。
  - TUI 使用 Ink/React 组件化拆分，输入、消息、权限、状态和工具日志各自独立。
  - Core 通过结构化消息与外层交互，适合未来接入 SDK、远程会话或后台任务。
  - Tool 注册中心集中管理工具能力，并允许按环境、权限和 feature flag 裁剪。
- `/Users/wzc/studyspace/openclaw/openclaw`
  - 包结构强调 runtime、provider、plugin、SDK、UI 的边界。
  - OpenAI Compatible provider 以独立扩展方式接入，DeepSeek 特殊流式/thinking 逻辑被封装在 provider 层。
  - SDK/transport/event hub 的抽象适合多端 UI 复用同一套 Agent Core 事件协议。

## 第一阶段目标

- `npx neros` 启动 TUI。
- 全屏 Terminal UI，包含顶部状态栏、聊天窗口、Tool 日志面板、输入栏和底部提示栏。
- 支持 OpenAI Compatible Chat Completions 流式输出。
- 内置 DeepSeek provider 默认配置，可通过环境变量切换模型、base URL 和 key。
- Agent Core 独立于 Ink，不直接引用 React、Ink、Node TTY 或浏览器 API。
- Tool 调用过程以结构化事件输出，TUI 只负责渲染，不参与 Agent 决策。
- 初期工具先实现安全、可验证的小集合：`read_file`、`list_files`、`grep`、`shell` 可先做成受控/可关闭能力。
- 为 Web、Desktop(Tauri)、HarmonyOS 保留 UI adapter 和 transport 扩展点。

## 非目标

- 第一版不实现完整 Claude Code 级别的权限系统、后台 session、MCP、插件市场和多 Agent 协作。
- 第一版不直接提供自动编辑大规模代码库的高风险能力，写文件与执行 shell 需要显式开关。
- 第一版不把 TUI 状态作为 Agent Core 的事实来源，Core 必须可在无 UI 环境运行。

## 技术栈

- Language: TypeScript
- Runtime: Node.js 20+
- Package Manager: pnpm
- CLI/TUI: Ink + React
- Build: tsup 或 tsdown
- Config: cosmiconfig 或自定义 JSON/YAML loader
- Validation: zod
- HTTP: undici/fetch
- Test: vitest
- Lint/Format: eslint + prettier 或 biome

## 推荐包结构

```text
neros/
  package.json
  README.md
  tsconfig.json
  src/
    entrypoints/
      cli.ts
      tui.tsx
    cli/
      args.ts
      bootstrap.ts
      env.ts
    core/
      agent/
        AgentRuntime.ts
        AgentLoop.ts
        types.ts
      llm/
        OpenAICompatibleClient.ts
        providers/
          deepseek.ts
          openai-compatible.ts
        stream.ts
        types.ts
      tools/
        Tool.ts
        registry.ts
        builtin/
          read-file.ts
          list-files.ts
          grep.ts
          shell.ts
      session/
        ConversationStore.ts
        transcript.ts
      events/
        AgentEvent.ts
        EventBus.ts
      config/
        loadConfig.ts
        schema.ts
    tui/
      App.tsx
      components/
        Layout.tsx
        ChatPane.tsx
        ToolLogPane.tsx
        InputBox.tsx
        StatusBar.tsx
      hooks/
        useAgentSession.ts
        useTerminalSize.ts
      state/
        reducer.ts
        types.ts
    adapters/
      tui/
        TuiAgentAdapter.ts
      web/
        WebAgentAdapter.placeholder.ts
      tauri/
        TauriAgentAdapter.placeholder.ts
      harmony/
        HarmonyAgentAdapter.placeholder.ts
    shared/
      ids.ts
      errors.ts
      logger.ts
```

核心原则：

- `src/core/**` 不依赖 `src/tui/**`。
- `src/tui/**` 只能通过 `AgentRuntime` 或 adapter 订阅事件、发送用户输入、请求取消。
- `src/adapters/**` 负责把不同 UI 平台的输入/输出转换为 Core 协议。
- Provider、Tool、Session、Event 都是 Core 能力，UI 只能展示它们。

## 架构分层

```text
User
  |
  v
UI Adapter
  - TUI: Ink
  - Web: browser transport
  - Desktop: Tauri command/event
  - HarmonyOS: native bridge
  |
  v
Agent Core
  - Agent loop
  - conversation/session
  - model client
  - tool registry
  - event bus
  |
  v
Providers / Tools / Storage
```

### Agent Core

Agent Core 是长期稳定层，负责：

- 接收用户消息和运行配置。
- 管理 conversation messages。
- 调用 OpenAI Compatible provider。
- 解析 streaming delta。
- 触发 tool call。
- 汇总 tool result 后继续模型循环。
- 通过 `AsyncIterable<AgentEvent>` 或事件总线向外发送状态。

Core 不应该：

- import Ink/React。
- 读取 stdin 或写 stdout。
- 直接控制 terminal cursor。
- 直接使用浏览器、Tauri 或 HarmonyOS API。

### UI Adapter

UI Adapter 负责：

- 把用户输入转换为 `AgentInput`。
- 订阅 `AgentEvent` 并转成 UI state。
- 提供取消、重试、清屏、切换模型等 UI 命令。
- 处理不同平台的生命周期差异。

第一版只实现 TUI Adapter，Web/Tauri/HarmonyOS 先保留占位模块和接口。

## 核心事件协议

所有 UI 共享同一套事件协议。初期建议：

```ts
export type AgentEvent =
  | { type: "session.started"; sessionId: string; cwd: string }
  | { type: "user.message"; id: string; content: string }
  | { type: "assistant.message.started"; id: string }
  | { type: "assistant.delta"; id: string; text: string }
  | { type: "assistant.message.completed"; id: string; usage?: TokenUsage }
  | { type: "tool.started"; id: string; name: string; input: unknown }
  | { type: "tool.delta"; id: string; chunk: string }
  | { type: "tool.completed"; id: string; output: unknown; elapsedMs: number }
  | { type: "tool.failed"; id: string; error: AgentError }
  | { type: "agent.status"; status: "idle" | "thinking" | "streaming" | "tooling" }
  | { type: "agent.error"; error: AgentError }
  | { type: "session.ended"; sessionId: string };
```

设计要求：

- 事件 append-only，TUI reducer 根据事件更新展示状态。
- 每个 message/tool 都有稳定 id，方便多端追踪和日志回放。
- Tool 日志不混入 assistant 正文，避免 UI 和 transcript 难以区分。
- 后续增加 WebSocket、IPC、Tauri event、Harmony bridge 时仍使用同一事件结构。

## OpenAI Compatible 与 DeepSeek

第一版只依赖 OpenAI Compatible Chat Completions API：

- `POST /chat/completions`
- `stream: true`
- SSE 流解析
- `choices[].delta.content`
- `choices[].delta.tool_calls`
- `usage`

环境变量：

```bash
NEROS_API_KEY=...
NEROS_BASE_URL=https://api.deepseek.com
NEROS_MODEL=deepseek-chat
NEROS_PROVIDER=deepseek
```

Provider 接口：

```ts
export type ModelProvider = {
  id: string;
  displayName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  createClient(config: ProviderConfig): ChatModelClient;
};
```

DeepSeek provider 初期策略：

- 默认 `baseURL` 为 `https://api.deepseek.com`。
- 默认模型可设为 `deepseek-chat`，通过 `NEROS_MODEL` 覆盖。
- 将 DeepSeek 特有的 reasoning/thinking 字段处理封装在 provider 层。
- Core 只消费标准化后的 `ModelStreamEvent`，不写 DeepSeek 分支。

## Tool 系统

Tool 采用注册中心模式，参考 Claude Code 的集中注册思路，但第一版保持轻量：

```ts
export type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  risk: "read" | "write" | "exec" | "network";
  isEnabled(context: ToolContext): boolean;
  run(input: Input, context: ToolContext): AsyncIterable<ToolEvent> | Promise<Output>;
};
```

初期内置工具：

- `read_file`: 读取工作区内文件。
- `list_files`: 列出工作区文件，底层优先使用 `rg --files`。
- `grep`: 搜索文本，底层优先使用 `rg`。
- `shell`: 受控 shell 执行，默认关闭或需要配置开启。

权限建议：

- 读工具默认允许，但限制在当前 workspace。
- 写工具第一阶段不默认提供。
- `shell` 默认需要用户确认，且在 TUI Tool 日志中展示命令、cwd、退出码。
- 所有 tool result 都进入 transcript，但 UI 可折叠展示。

## TUI 设计

第一版全屏布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ Neros  model: deepseek-chat  cwd: ~/project  status: idle     │
├──────────────────────────────────────┬───────────────────────┤
│ Chat                                 │ Tool Logs             │
│                                      │                       │
│ user                                 │ read_file started     │
│ assistant streaming...               │ grep completed 42ms   │
│                                      │                       │
├──────────────────────────────────────┴───────────────────────┤
│ > 输入消息，Enter 发送，Shift+Enter 换行，Ctrl+C 退出          │
└──────────────────────────────────────────────────────────────┘
```

组件建议：

- `App`: 装配 provider、session、全局快捷键。
- `Layout`: 根据 terminal 宽高分配区域。
- `StatusBar`: 模型、cwd、token、状态、网络错误。
- `ChatPane`: user/assistant/tool summary 消息列表。
- `ToolLogPane`: tool started/delta/completed/failed。
- `InputBox`: 多行输入、历史记录、发送/取消。

交互要求：

- 输出流式刷新，但限制 repaint 频率，避免大文本卡顿。
- Tool 日志独立滚动，聊天窗口只显示简要 tool summary。
- Ctrl+C 第一次取消当前 run，空闲时再次退出。
- Provider key 缺失时进入配置提示，而不是直接崩溃。

## npx 启动与发布

`package.json` 初期建议：

```json
{
  "name": "neros",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "neros": "./dist/entrypoints/cli.js"
  },
  "files": [
    "dist",
    "README.md",
    "package.json"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "tsx src/entrypoints/cli.ts",
    "build": "tsup src/entrypoints/cli.ts --format esm --dts --clean",
    "start": "node dist/entrypoints/cli.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

启动路径建议：

1. `entrypoints/cli.ts` 只做参数解析、环境初始化和快速命令。
2. 普通 TUI 模式动态 import `entrypoints/tui.tsx`。
3. `tui.tsx` 创建 `AgentRuntime`，并用 Ink render `App`。
4. `App` 通过 adapter 与 Core 通信。

这样可以让 `neros --version`、`neros --help` 很快返回，也方便未来增加 `neros run --json` 这类非 TUI 模式。

## 配置

配置优先级：

1. CLI flags
2. 环境变量
3. 项目配置 `.nerosrc.json`
4. 用户配置 `~/.neros/config.json`
5. provider 默认值

示例：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com",
  "tools": {
    "read_file": true,
    "list_files": true,
    "grep": true,
    "shell": false
  },
  "ui": {
    "toolLogPane": true,
    "theme": "system"
  }
}
```

## 面向多端的扩展计划

### Web

- Core 编译为纯 TypeScript package。
- Web UI 不直接运行高风险本地工具，改走 server/worker transport。
- 使用同一套 `AgentEvent` 渲染聊天和 Tool 日志。

### Desktop(Tauri)

- Tauri 前端通过 command/event 调用 Node sidecar 或 Rust bridge。
- 本地文件、shell、权限弹窗由 Tauri adapter 承担。
- Core 仍保持无 UI 依赖。

### HarmonyOS

- HarmonyOS UI 通过 bridge 调用远端 Agent Runtime 或本地轻量 runtime。
- 本地能力受平台限制时，Tools 以 capability discovery 方式注册。
- 保持事件协议稳定，避免为单个平台改 Core。

## 测试策略

第一阶段需要覆盖：

- `OpenAICompatibleClient` SSE parser 单测。
- DeepSeek provider 默认配置和流式字段归一化单测。
- `AgentLoop` 在纯 mock provider 下的用户消息、assistant delta、tool call 流程。
- Tool registry 的 enable/disable、schema validation、错误事件。
- TUI reducer 对 `AgentEvent` 的状态更新。
- CLI `--help`、`--version`、缺失 API key 的行为。

建议先写 Core 测试，再写 TUI 快照或组件级测试。TUI 视觉细节可以晚一点完善，但 Core 事件协议一开始就要稳定。

## 里程碑

### M0: 项目骨架

- 初始化 package、TypeScript、build、test。
- 实现 `npx neros --help` 和 `--version`。
- 建立 `core`、`tui`、`adapters` 目录边界。

### M1: 最小聊天闭环

- 实现 DeepSeek/OpenAI Compatible client。
- 实现 stream parser。
- 实现 `AgentRuntime.sendMessage()` 和事件流。
- TUI 展示用户消息与 assistant 流式输出。

### M2: Tool 日志

- 加入 Tool registry。
- 实现 `read_file`、`list_files`、`grep`。
- TUI 右侧 Tool 日志面板实时展示 tool 生命周期。

### M3: 可用 CLI 产品形态

- 配置加载。
- 缺 key 引导。
- Ctrl+C 取消/退出。
- transcript 保存。
- 发布前 package files 检查。

### M4: 多端准备

- 抽出 `@neros/core` 内部边界。
- 定义 transport adapter。
- 增加 `run --json` 或 SDK demo，证明 Core 可脱离 TUI 使用。

## 开发约束

- Core 中禁止 import `ink`、`react`、`process.stdin`、`process.stdout`。
- Provider 中禁止直接修改 UI state。
- Tool 输出必须结构化，不把日志直接写 stdout。
- UI reducer 必须只消费事件，不直接读取 provider/tool 内部对象。
- 所有外部 API key 不写入 transcript。
- 默认 provider 是 DeepSeek，但实现必须保持 OpenAI Compatible 泛化。

## 初期实现顺序

推荐按以下顺序开工：

1. 搭建 TypeScript package 与 CLI bin。
2. 定义 `AgentEvent`、`AgentInput`、`ModelStreamEvent`、`Tool` 类型。
3. 实现 OpenAI Compatible streaming client。
4. 实现 DeepSeek provider。
5. 实现无 UI 的 `AgentRuntime` mock 测试。
6. 实现 Ink 全屏布局和 reducer。
7. 接入真实 DeepSeek 流式聊天。
8. 加入 Tool registry 与 Tool 日志面板。

这条路径可以先跑通核心闭环，再逐步加工具和多端能力，避免第一版被 UI、权限、插件和 provider 差异同时拖住。
