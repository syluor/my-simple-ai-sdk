/**
 * @aderaaaa/ai-sdk — OpenAI 兼容的极简 AI SDK
 *
 * 用法示例见 README.md 或项目根 index.ts
 */

// ============================================================
// 错误类型
// ============================================================

export class AIError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "AIError"
  }
}

// ============================================================
// namespace ai —— 既是值又是类型的统一入口
// ============================================================

export namespace ai {
  // -------------------- 类型定义 --------------------

  /** JSON Schema 基础类型 */
  export type SchemaType =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object"
    | "null"

  /** 工具参数 schema */
  export interface ParamSchema {
    /** JSON Schema 类型 */
    type: SchemaType
    /** 参数描述（喂给 LLM） */
    description: string
    /** 是否必填，默认 true */
    required?: boolean
  }

  // ---- OpenAI 消息格式 ----

  export interface SystemMessage {
    role: "system"
    content: string
  }
  export interface UserMessage {
    role: "user"
    content: string
  }
  export interface AssistantToolCall {
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }
  export interface AssistantMessage {
    role: "assistant"
    content: string | null
    tool_calls?: AssistantToolCall[]
  }
  export interface ToolMessage {
    role: "tool"
    content: string
    tool_call_id: string
  }

  /** 四种 OpenAI 消息的联合类型 */
  export type Message =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolMessage
  /** 消息数组 */
  export type Messages = Message[]

  // ---- Config ----

  export interface Config {
    /** 模型 ID，如 "gpt-4o-mini" */
    modelId: string
    /** 完整的 chat completions endpoint URL，SDK 不做任何后缀拼接 */
    apiURL: string
    /** API Key */
    apiKey: string
    /** 是否流式（默认 true） */
    stream?: boolean
    /** 重试次数（默认 3） */
    retryTimes?: number
    /** 指数退避（默认 true） */
    exponentialBackoff?: boolean
    /** 单次请求超时，毫秒（默认 30000） */
    timeout?: number
    /** 自定义请求 body 字段，会 merge 到 SDK 默认 body 上（同名字段以自定义为准） */
    customBodyConfig?: Record<string, unknown>
    /** 自定义请求 header 字段，会 merge 到 SDK 默认 header 上（同名字段以自定义为准） */
    customHeaderConfig?: Record<string, unknown>
  }
  /** 已合并默认值的 Config */
  export type ResolvedConfig = Required<Config>

  // ---- Tool ----

  /** defineTool 入参 */
  export interface ToolDef<
    TArgs extends unknown[] = unknown[],
    TOutput = unknown,
  > {
    /**
     * 显式工具名（可选）。
     * - 不传则用 output 函数的 name
     * - 若 output 是匿名箭头函数赋给对象属性，JS 会自动推断 name 为 "output"，多工具会冲突
     * - 都拿不到时抛 AIError
     */
    name?: string
    /** 参数 schema（按字段顺序匹配 output 入参） */
    input: Record<string, ParamSchema>
    /** 工具实现。参数顺序 = input schema 中声明的字段顺序 */
    output: (...args: TArgs) => TOutput | Promise<TOutput>
    /** 喂给 LLM 的工具描述（可选，默认用 name） */
    description?: string
  }

  /** 工具实例 */
  export interface ToolInstance<
    TArgs extends unknown[] = unknown[],
    TOutput = unknown,
  > {
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, ParamSchema>
    readonly output: (...args: TArgs) => TOutput | Promise<TOutput>
    /**
     * 执行工具。
     * - 直接调用：传入 args，按 inputSchema 字段顺序匹配 output 入参
     * - 通过 requiredTools 调用：SDK 已绑定 args，可不传
     */
    execute(args?: Record<string, unknown>): Promise<TOutput>
    /** 转 OpenAI tools 数组元素 */
    toJSON(): {
      type: "function"
      function: {
        name: string
        description: string
        parameters: {
          type: "object"
          properties: Record<string, unknown>
          required: string[]
        }
      }
    }
  }

  /** requiredTool: SDK 已绑定 args 的工具调用 */
  export interface RequiredTool<
    TArgs extends unknown[] = unknown[],
    TOutput = unknown,
  > {
    /** 已绑定 args 的工具实例（execute 可无参调用） */
    tool: ToolInstance<TArgs, TOutput>
    /** 对应 OpenAI tool_call.id */
    tool_call_id: string
    /** LLM 解析出的参数（同样绑定在 tool 上） */
    args: Record<string, unknown>
  }

  // ---- Result ----

  /**
   * 流式 request 的返回。
   *
   * stream 是真·实时流（边到边吐）；message / requiredTools 走异步获取——
   * 首次调用 getMessage() / getRequiredTools() 会内部把流读完并缓存，
   * 之后调用（以及 stream 的消费）都从缓存读。调用顺序任意：
   *  - 先 stream 后 getMessage：stream 实时边来边吐，getMessage 立即返回缓存
   *  - 先 getMessage 后 stream：getMessage 内部 drain 整个流，stream 之后从缓存重放
   */
  export interface StreamingResult {
    /** content delta 的实时流，可重复消费（多次 for await 都从缓存/进度读） */
    stream: AsyncIterable<string>
    /** 获取完整 assistant message（流读完时可用，结果缓存） */
    getMessage(): Promise<AssistantMessage>
    /** 获取工具调用列表（语义同 getMessage，结果缓存） */
    getRequiredTools(): Promise<RequiredTool[] | undefined>
  }
  /** 非流式 request 的返回 */
  export interface NonStreamingResult {
    message: AssistantMessage
    requiredTools?: RequiredTool[]
  }
  /** 统一 Result 类型（按 streaming / non-streaming 索引） */
  export type Result = {
    streaming: StreamingResult
    "non-streaming": NonStreamingResult
  }

  // -------------------- 函数实现 --------------------

  const DEFAULT_CONFIG = {
    stream: true,
    retryTimes: 3,
    exponentialBackoff: true,
    timeout: 30_000,
    customBodyConfig: {} as Record<string, unknown>,
    customHeaderConfig: {} as Record<string, unknown>,
  }

  /**
   * 定义配置。合并默认值并校验必填字段。
   *
   * 各家 OpenAI 兼容服务的 API 文档：
   *
   * - OpenAI: https://platform.openai.com/docs/api-reference/chat
   * - DeepSeek: https://api-docs.deepseek.com/
   * - 智谱 (ZhipuAI / GLM): https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
   * - Kimi (Moonshot): https://platform.moonshot.cn/docs/api/chat
   * - 通义千问 (DashScope): https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
   */
  export function defineConfig(config: Config): ResolvedConfig {
    if (!config.modelId) throw new AIError("modelId is required")
    if (!config.apiURL) throw new AIError("apiURL is required")
    if (!config.apiKey) throw new AIError("apiKey is required")
    return { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 定义工具。
   *
   * @example
   * ```ts
   * const add = ai.defineTool({
   *   name: "add",                  // 可选；默认取 output.name
   *   input: {
   *     a: { type: "number", description: "first number" },
   *     b: { type: "number", description: "second number" },
   *   },
   *   output: (a: number, b: number) => a + b,
   * })
   * ```
   */
  export function defineTool<
    const TArgs extends unknown[],
    TOutput,
  >(def: ToolDef<TArgs, TOutput>): ToolInstance<TArgs, TOutput> {
    const outputFn = def.output
    const toolName = def.name ?? (outputFn.name && outputFn.name !== "output" ? outputFn.name : "")
    if (!toolName) {
      throw new AIError(
        "Tool name is required. Pass `name` explicitly or use a named function for `output`.",
      )
    }
    const toolDescription = def.description ?? toolName

    const instance: ToolInstance<TArgs, TOutput> = {
      name: toolName,
      description: toolDescription,
      inputSchema: def.input,
      output: outputFn,
      async execute(args?: Record<string, unknown>): Promise<TOutput> {
        const schema = def.input
        const keys = Object.keys(schema)
        const orderedArgs = keys.map((k) => args?.[k]) as unknown as TArgs
        return await outputFn(...orderedArgs)
      },
      toJSON() {
        const properties: Record<string, unknown> = {}
        const requiredList: string[] = []
        for (const [key, schema] of Object.entries(def.input)) {
          properties[key] = {
            type: schema.type,
            description: schema.description,
          }
          if (schema.required !== false) requiredList.push(key)
        }
        return {
          type: "function" as const,
          function: {
            name: toolName,
            description: toolDescription,
            parameters: {
              type: "object" as const,
              properties,
              required: requiredList,
            },
          },
        }
      },
    }
    return instance
  }

  /**
   * 创建 ai 实例。传入 config 与工具列表。
   * 返回的实例有 request 方法。
   *
   * 注意：tools 元素的类型参数会被擦除（existential），
   * 单个 tool 自身保留 input/output 推断，但传入 defineai 后视为公共基型。
   */
  export function defineai(
    config: ResolvedConfig,
    tools: ReadonlyArray<ToolInstance<any, any>> = [],
  ): {
    request: (messages: Messages) => Promise<
      Config["stream"] extends false ? NonStreamingResult : StreamingResult
    >
  } {
    return {
      async request(messages: Messages) {
        const requestBody: Record<string, unknown> = {
          model: config.modelId,
          messages,
          stream: config.stream,
          ...config.customBodyConfig,
        }
        if (tools.length > 0) {
          requestBody.tools = tools.map((t) => t.toJSON())
        }

        const res = await chatRequest(config, requestBody)

        if (config.stream) {
          return createStreamingResult(
            res,
            tools as ToolInstance<any, any>[],
          ) as any
        } else {
          return (await parseNonStreamingResponse(
            res,
            tools as ToolInstance<any, any>[],
          )) as any
        }
      },
    }
  }

  // -------------------- 内部辅助函数 --------------------

  /** 单次 HTTP 请求，含 timeout；外层带 retry */
  async function chatRequest(
    config: ResolvedConfig,
    body: Record<string, unknown>,
  ): Promise<Response> {
    let lastError: unknown
    let delay = 1_000

    for (let attempt = 0; attempt <= config.retryTimes; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeout)
      try {
        const res = await fetch(config.apiURL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
            ...config.customHeaderConfig,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timer)
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw new AIError(`HTTP ${res.status} ${res.statusText}: ${text}`)
        }
        return res
      } catch (err) {
        clearTimeout(timer)
        lastError = err
        if (attempt < config.retryTimes) {
          const wait = config.exponentialBackoff ? delay : 1_000
          await new Promise((r) => setTimeout(r, wait))
          delay *= 2
        }
      }
    }
    throw new AIError(
      `All ${config.retryTimes + 1} attempts failed`,
      lastError,
    )
  }

  /** 解析非流式响应 */
  async function parseNonStreamingResponse(
    res: Response,
    tools: ToolInstance[],
  ): Promise<NonStreamingResult> {
    const data = (await res.json()) as {
      choices?: Array<{ message?: AssistantMessage }>
    }
    const message = data.choices?.[0]?.message
    if (!message) throw new AIError("No message in response", data)
    return {
      message,
      requiredTools: buildRequiredTools(message, tools),
    }
  }

  /**
   * 构造流式 result（不阻塞，立即返回）。
   *
   * 设计：单一 driver 协程（幂等启动）负责读取 res.body，把每个 content delta
   * push 到共享 chunks 数组并唤醒 stream 消费者；流结束时构造完整 message /
   * requiredTools 缓存。stream 是可重复消费的 AsyncIterable（每次 [Symbol.asyncIterator]
   * 从头跟随实时进度）。getMessage() / getRequiredTools() 触发 ensureDriver()
   * 并等待 driver 完成后返回缓存。
   *
   * 谁先调用谁驱动，另一边从缓存读，两边都能工作。
   */
  function createStreamingResult(
    res: Response,
    tools: ToolInstance[],
  ): StreamingResult {
    if (!res.body) throw new AIError("No response body")

    // ---- 共享状态 ----
    const chunks: string[] = []
    let message: AssistantMessage | null = null
    let requiredTools: RequiredTool[] | undefined
    let state: "idle" | "running" | "done" = "idle"
    let driverError: unknown = null
    let driverPromise: Promise<void> | null = null
    /** stream 消费者挂起的回调；driver 每次 push chunk / 结束时唤醒 */
    const waiters: Array<() => void> = []

    const wake = () => {
      if (waiters.length === 0) return
      const pending = waiters.splice(0)
      for (const fn of pending) fn()
    }

    // ---- driver：读流 → 填 chunks → 构造 message（只跑一次，幂等启动）----
    async function driver(): Promise<void> {
      state = "running"
      const decoder = new TextDecoder()
      const reader = res.body!.getReader()
      let contentBuf = ""
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; argsBuf: string }
      >()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line.startsWith("data:")) continue
            const payload = line.slice(5).trim()
            if (payload === "[DONE]") continue
            let parsed: any
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            const delta = parsed?.choices?.[0]?.delta
            if (!delta) continue

            if (typeof delta.content === "string" && delta.content) {
              contentBuf += delta.content
              chunks.push(delta.content)
              wake()
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0
                let entry = toolCallsMap.get(idx)
                if (!entry) {
                  entry = { id: "", name: "", argsBuf: "" }
                  toolCallsMap.set(idx, entry)
                }
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name = tc.function.name
                if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
              }
            }
          }
        }

        const toolCalls: AssistantToolCall[] | undefined =
          toolCallsMap.size > 0
            ? [...toolCallsMap.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, entry]) => ({
                  id: entry.id,
                  type: "function" as const,
                  function: { name: entry.name, arguments: entry.argsBuf },
                }))
            : undefined

        message = {
          role: "assistant",
          content: contentBuf || null,
          tool_calls: toolCalls,
        }
        requiredTools = buildRequiredTools(message, tools)
      } catch (e) {
        driverError = e
      } finally {
        reader.releaseLock()
        state = "done"
        wake()
      }
    }

    function ensureDriver(): Promise<void> {
      if (!driverPromise) driverPromise = driver()
      return driverPromise
    }

    // ---- stream：可重复消费的 AsyncIterable（跟随实时进度 / 从缓存重放）----
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        ensureDriver()
        let cursor = 0
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              if (cursor < chunks.length) {
                const v = chunks[cursor]!
                cursor++
                return { value: v, done: false }
              }
              if (state === "done") {
                if (driverError) throw driverError
                return { value: undefined, done: true }
              }
              await new Promise<void>((resolve) => waiters.push(resolve))
            }
          },
        }
      },
    }

    return {
      stream,
      async getMessage(): Promise<AssistantMessage> {
        await ensureDriver()
        if (driverError) throw driverError
        return message!
      },
      async getRequiredTools(): Promise<RequiredTool[] | undefined> {
        await ensureDriver()
        if (driverError) throw driverError
        return requiredTools
      },
    }
  }

  /** 从 message.tool_calls 构造 requiredTools（含绑定的 execute） */
  function buildRequiredTools(
    message: AssistantMessage,
    tools: ToolInstance[],
  ): RequiredTool[] | undefined {
    const toolCalls = message.tool_calls
    if (!toolCalls || toolCalls.length === 0) return undefined

    return toolCalls.map((tc) => {
      const original = tools.find((t) => t.name === tc.function.name)
      if (!original) throw new AIError(`Unknown tool: ${tc.function.name}`)
      let args: Record<string, unknown> = {}
      if (tc.function.arguments) {
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          throw new AIError(
            `Invalid tool arguments JSON for ${tc.function.name}: ${tc.function.arguments}`,
          )
        }
      }
      const boundTool = bindToolArgs(original, args)
      return { tool: boundTool, tool_call_id: tc.id, args }
    })
  }

  /** 绑定 args：返回 execute 已闭包的工具实例 */
  function bindToolArgs<TArgs extends unknown[], TOutput>(
    tool: ToolInstance<TArgs, TOutput>,
    args: Record<string, unknown>,
  ): ToolInstance<TArgs, TOutput> {
    return {
      ...tool,
      async execute(): Promise<TOutput> {
        return tool.execute(args)
      },
    }
  }
}
