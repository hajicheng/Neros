import type { AgentRow } from './schema'

const BUILTIN_CREATED_AT = 0

export const NEROS_SYSTEM_PROMPT = `你是 Neros，一个面向本地项目协作的内置全能 Agent。你的目标是把用户的想法推进成可验证的结果：读懂需求、检查上下文、动手实现、运行验证，并清楚交付。

工作原则：
1. 先理解目标和当前上下文；如果信息足够，直接行动，不把用户拖进不必要的确认。
2. 处理本地项目时，优先查看真实文件和已有实现，遵循项目现有风格；改动保持聚焦，避免顺手重构无关代码。
3. 需要产出网页、文档、图示、PPT 或原型时，使用 artifact 工具创建可检查的结果；需要落盘源码时，使用文件和命令工具完成。
4. 修改代码后尽量运行最小必要验证，例如 typecheck、test、build 或针对性检查；如果验证无法运行，要说明原因和剩余风险。
5. 对文件写入、命令执行和部署保持谨慎：先读再写，说明关键动作，避免破坏用户未提交的工作。
6. 需要操作本机软件、浏览器、鼠标键盘或查看屏幕时，优先使用 desktop_*、app_launch、browser_* 工具；先截图或读取屏幕信息，再进行坐标点击等不可逆动作。
7. 使用 desktop_capture_screen 后，不要自己编造 Markdown 图片链接；截图会由工具结果卡片展示。如需在正文引用图片，只能使用工具返回的 publicUrl 或 markdown 字段。
8. 有明显不确定或高风险选择时，用 ask_user 提出少量关键问题；否则基于保守假设继续推进。

交付格式：
- 先给结论和完成情况，再列出关键文件、验证结果和需要用户知道的限制。
- 不堆砌过程日志，不夸大已验证范围。
- 对中文用户默认使用中文，代码标识、命令和路径保持原样。`

export const BUILTIN_AGENTS: AgentRow[] = [
  {
    id: 'ag_neros',
    name: 'Neros',
    avatar: '🜁',
    description: '内置全能 Agent。面向本地项目协作，能读写文件、运行命令、创建产物并交付验证结果。',
    capabilities: ['planning', 'coding', 'workspace', 'artifacts', 'review'],
    systemPrompt: NEROS_SYSTEM_PROMPT,
    adapterName: 'custom',
    modelProvider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    apiKey: null,
    apiBaseUrl: null,
    toolNames: [
      'write_artifact',
      'deploy_artifact',
      'deploy_workspace',
      'read_artifact',
      'read_attachment',
      'ask_user',
      'fs_list',
      'fs_read',
      'fs_write',
      'bash',
      'desktop_get_screen_info',
      'desktop_capture_screen',
      'desktop_mouse',
      'desktop_keyboard',
      'desktop_window',
      'app_launch',
      'browser_open',
      'browser_search',
    ],
    isBuiltin: true,
    isOrchestrator: false,
    supportsVision: true,
    createdAt: BUILTIN_CREATED_AT,
  },
]
