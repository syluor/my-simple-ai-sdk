# @aderaaaa/ai-sdk

OpenAI 兼容的极简 AI SDK。零运行时依赖，类型安全，支持流式响应与工具调用（tool calling）。

## 特性

- 🪶 **极简 API**：`defineConfig` / `defineTool` / `defineai` 三件套
- 🔌 **OpenAI 兼容**：任何实现了 OpenAI Chat Completions `/v1/chat/completions` 的服务都能用（OpenAI / DeepSeek / 智谱 / Ollama / vLLM / llama.cpp 等）
- 🌊 **流式 / 非流式**：通过 `stream` 配置切换
- 🛠️ **工具调用**：自动处理 `tool_calls` 往返，参数解析、`execute()` 自动绑定
- 🔁 **重试 + 指数退避**：网络抖动 / 5xx 自动重试
- 🧷 **类型安全**：完全用 TypeScript 编写，类型推断友好
- 📦 **零依赖**：仅依赖 Node 18+ 内置 `fetch`

## 安装

```bash
npm install @aderaaaa/ai-sdk
# 或
bun add @aderaaaa/ai-sdk
```

要求 Node.js ≥ 18（用到内置 `fetch` / `AbortController` / `ReadableStream`）。

## 快速开始

```ts
import { ai } from "@aderaaaa/ai-sdk"

// 1. 定义配置
const config = ai.defineConfig({
  modelId: "gpt-4o-mini",
  apiURL: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  stream: true,              // 可选，默认 true
  retryTimes: 3,             // 可选，默认 3
  exponentialBackoff: true,  // 可选，默认 true
  timeout: 30_000,           // 可选，默认 30000ms
})

// 2. 定义工具（可选）
const add = ai.defineTool({
  name: "add",
  description: "整数加法",
  input: {
    a: { type: "number", description: "第一个加数" },
    b: { type: "number", description: "第二个加数", required: false },
  },
  output: (a: number, b: number) => a + b,
})

// 3. 创建 ai 实例
const ai1 = ai.defineai(config, [add])

// 4. 多轮 tool-use 循环
const messages: ai.Messages = [
  { role: "system", content: "你是一个会用工具的计算助手" },
  { role: "user", content: "3 加 5 等于多少？" },
]

while (true) {
  const result = await ai1.request(messages)

  // 真·实时流式输出（边到边吐）
  for await (const chunk of result.stream) {
    process.stdout.write(chunk)
  }

  messages.push(await result.getMessage())

  // LLM 触发了工具调用：执行工具，回推结果，继续循环
  const requiredTools = await result.getRequiredTools()
  if (requiredTools && requiredTools.length > 0) {
    for (const rt of requiredTools) {
      const ret = await rt.tool.execute()  // 已绑定 args，无参调用
      messages.push({
        role: "tool",
        tool_call_id: rt.tool_call_id,
        content: String(ret),
      })
    }
    continue
  }

  // 否则：拿到最终答案
  console.log()
  break
}
```

## API

### `ai.defineConfig(config)`

合并默认值并校验必填字段。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelId` | `string` | — | **必填** 模型 ID |
| `apiURL` | `string` | — | **必填** 完整的 chat completions endpoint URL（SDK 不做任何后缀拼接，如 `https://api.openai.com/v1/chat/completions`） |
| `apiKey` | `string` | — | **必填** API Key |
| `stream` | `boolean` | `true` | 是否流式 |
| `retryTimes` | `number` | `3` | 失败重试次数 |
| `exponentialBackoff` | `boolean` | `true` | 指数退避（每次失败等待时间翻倍） |
| `timeout` | `number` | `30000` | 单次请求超时（毫秒） |
| `customBodyConfig` | `Record<string, unknown>` | `{}` | 自定义请求 body 字段，会 merge 到 SDK 默认 body 之后（同名字段以自定义为准，可覆盖 `model` / `messages` / `stream` / `tools`） |
| `customHeaderConfig` | `Record<string, unknown>` | `{}` | 自定义请求 header 字段，会 merge 到 SDK 默认 header 之后（同名字段以自定义为准，可覆盖 `Authorization` / `Content-Type`） |

### `ai.defineTool(def)`

定义工具。`def` 含字段：

- `name?: string` — 工具名（OpenAI tool 名）。不传则用 `output` 函数的 `name`；都拿不到时抛 `AIError`
- `description?: string` — 工具描述（喂给 LLM）。默认等于 name
- `input: Record<string, ParamSchema>` — 参数 schema，按字段顺序匹配 `output` 入参
- `output: (...args) => T | Promise<T>` — 工具实现

`ParamSchema`：

```ts
{ type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null"
, description: string
, required?: boolean   // 默认 true
}
```

返回的 `ToolInstance` 有 `execute(args?)` 与 `toJSON()` 方法。

### `ai.defineai(config, tools?)`

创建 ai 实例。`tools` 默认为空数组。

返回的对象有 `request(messages)` 异步方法：

- **流式**（默认）：返回 `StreamingResult`
  ```ts
  { stream: AsyncIterable<string>   // content delta 实时流，可重复消费
  , getMessage(): Promise<AssistantMessage>
  , getRequiredTools(): Promise<RequiredTool[] | undefined>
  }
  ```
  `stream` 是真·实时流，每个 delta 到达即 yield。`getMessage()` / `getRequiredTools()`
  是幂等的异步获取函数：首次调用会内部把流读完并缓存结果，之后调用（以及 `stream`
  的消费）都从缓存读。**调用顺序任意**——先消费 `stream` 边到边吐再 `await getMessage()`，
  或先 `await getMessage()`（内部 drain 流）再 `for await stream`（从缓存重放），都能工作。

  ```ts
  const result = await ai1.request(messages)
  // 方式 A：先实时流式输出，再拿完整 message
  for await (const chunk of result.stream) process.stdout.write(chunk)
  messages.push(await result.getMessage())
  // 方式 B：只要完整结果，不关心过程
  // messages.push(await result.getMessage())
  ```
- **非流式**（`stream: false`）：返回 `NonStreamingResult`
  ```ts
  { message: AssistantMessage
  , requiredTools?: RequiredTool[]
  }
  ```

### `RequiredTool`

```ts
{ tool: ToolInstance   // 已绑定 args，execute() 可无参调用
, tool_call_id: string // 对应 OpenAI tool_call.id
, args: Record<string, unknown>
}
```

## 类型

```ts
import type { ai } from "@aderaaaa/ai-sdk"

type M = ai.Message   // = SystemMessage | UserMessage | AssistantMessage | ToolMessage
type Ms = ai.Messages // = Message[]
type R = ai.Result["streaming"]
type R2 = ai.Result["non-streaming"]
```

`ai` 是 TypeScript namespace，既是值（含 `defineConfig` / `defineTool` / `defineai` 函数），又是类型容器（含 `Message` / `Messages` / `Result` 等）。

## 错误处理

SDK 自定义错误类 `AIError`：

```ts
import { AIError } from "@aderaaaa/ai-sdk"

try {
  await ai1.request(messages)
} catch (e) {
  if (e instanceof AIError) {
    console.error("SDK 错误:", e.message, e.cause)
  }
}
```

## 兼容性矩阵

已在以下 OpenAI 兼容服务上测试通过（理论上支持任何 OpenAI 格式 API）：

- OpenAI `gpt-4o` / `gpt-4o-mini`
- DeepSeek `deepseek-chat` / `deepseek-reasoner`
- 智谱 `glm-4` / `glm-4-flash`
- Ollama（开启 `OLLAMA_HOST` 即可，OpenAI 兼容端点）
- llama.cpp `llama-server`（`--api-key` 启用 OpenAI 兼容端点）

## License

MIT
