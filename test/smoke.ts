/**
 * 端到端测试：用本地 mock server 模拟 OpenAI 兼容 API
 * 覆盖：非流式、流式、工具调用、错误重试
 *
 * 运行: bun test/smoke.ts
 */
import { aiSdk, AIError } from "../src/index"

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++
    console.log(`  ✅ ${msg}`)
  } else {
    fail++
    console.error(`  ❌ ${msg}`)
  }
}

/** 启动一个返回预设响应的 mock server */
async function startMockServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const port = 30000 + Math.floor(Math.random() * 10000)
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      return await handler(req)
    },
  })
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => server.stop(true),
  }
}

function sseBody(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))
      }
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`))
      controller.close()
    },
  })
}

// ============================================================
// 测试 1: 非流式 + 工具调用
// ============================================================
async function testNonStreamingWithTool() {
  console.log("\n[T1] 非流式 + 工具调用")
  let receivedBody: any
  const server = await startMockServer(async (req) => {
    receivedBody = await req.json()
    const last = receivedBody.messages.at(-1)
    if (last?.role === "user" && last.content.includes("加法")) {
      // 第一次：返回 tool_call
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_abc",
              type: "function",
              function: { name: "add", arguments: JSON.stringify({ a: 3, b: 5 }) },
            }],
          },
        }],
      })
    } else {
      // 第二次：返回最终答案
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "结果是 8" },
        }],
      })
    }
  })

  try {
    const config = aiSdk.defineConfig({
      modelId: "test-model",
      apiURL: server.url,
      apiKey: "test-key",
      stream: false,
      retryTimes: 0,
    })
    const add = aiSdk.defineTool({
      name: "add",
      description: "加法",
      input: {
        a: { type: "number", description: "a" },
        b: { type: "number", description: "b" },
      },
      output: (a: number, b: number) => a + b,
    })
    const inst = aiSdk.defineAi(config, [add])

    assert(inst !== undefined, "defineAi 返回实例")

    const messages: aiSdk.Messages = [
      { role: "user", content: "请用加法工具算 3+5" },
    ]

    const r1 = await inst.request(messages)
    assert(r1.message.role === "assistant", "r1.message.role = assistant")
    assert(r1.requiredTools !== undefined, "r1 触发了 tool call")
    assert(r1.requiredTools!.length === 1, "r1 只有 1 个 requiredTool")
    assert(r1.requiredTools![0]!.tool_call_id === "call_abc", "tool_call_id 正确")
    assert(r1.requiredTools![0]!.args.a === 3, "args.a = 3")
    assert(r1.requiredTools![0]!.args.b === 5, "args.b = 5")

    // 绑定的 execute 无参调用
    const toolResult = await r1.requiredTools![0]!.tool.execute()
    assert(toolResult === 8, "bound execute() 返回 8")

    // 推回 messages
    messages.push(r1.message)
    messages.push({
      role: "tool",
      tool_call_id: "call_abc",
      content: String(toolResult),
    })

    // 二次调用：拿到最终答案
    const r2 = await inst.request(messages)
    assert(r2.message.content === "结果是 8", "r2 返回最终结果")
    assert(r2.requiredTools === undefined, "r2 无 tool call")

    // 验证 SDK 发给 server 的请求体
    assert(receivedBody.tools?.length === 1, "SDK 在请求中传了 1 个 tool")
    assert(receivedBody.tools?.[0].function.name === "add", "tool name = add")
    assert(receivedBody.stream === false, "stream=false 正确传给 server")
    assert(receivedBody.model === "test-model", "model 字段正确")
  } finally {
    server.close()
  }
}

// ============================================================
// 测试 2: 流式 + 内容累积
// ============================================================
async function testStreamingContent() {
  console.log("\n[T2] 流式 + 内容累积")
  const server = await startMockServer(async () => {
    return new Response(sseBody([
      { choices: [{ delta: { content: "你好" } }] },
      { choices: [{ delta: { content: "，" } }] },
      { choices: [{ delta: { content: "世界" } }] },
    ]), { headers: { "content-type": "text/event-stream" } })
  })

  try {
    const config = aiSdk.defineConfig({
      modelId: "test-model",
      apiURL: server.url,
      apiKey: "test-key",
      stream: true,
      retryTimes: 0,
    })
    const inst = aiSdk.defineAi(config, [])
    const r = await inst.request([{ role: "user", content: "hi" }])

    const consumed: string[] = []
    for await (const chunk of r.stream) consumed.push(chunk)
    assert(consumed.length === 3, "stream 回放了 3 个 chunks")
    assert(consumed.join("") === "你好，世界", "stream 内容拼接正确")

    const msg = await r.getMessage()
    assert(msg.content === "你好，世界", "累积内容正确")
    assert(msg.role === "assistant", "role 正确")
  } finally {
    server.close()
  }
}

// ============================================================
// 测试 3: 流式 + 工具调用（分片 arguments）
// ============================================================
async function testStreamingToolCall() {
  console.log("\n[T3] 流式 + 工具调用（分片 arguments）")
  const server = await startMockServer(async () => {
    return new Response(sseBody([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "add", arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '4' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"b":10}' } }] } }] },
    ]), { headers: { "content-type": "text/event-stream" } })
  })

  try {
    const config = aiSdk.defineConfig({
      modelId: "m",
      apiURL: server.url,
      apiKey: "k",
      stream: true,
      retryTimes: 0,
    })
    const add = aiSdk.defineTool({
      name: "add",
      input: {
        a: { type: "number", description: "" },
        b: { type: "number", description: "" },
      },
      output: (a: number, b: number) => a + b,
    })
    const inst = aiSdk.defineAi(config, [add])
    const r = await inst.request([{ role: "user", content: "" }])

    const requiredTools = await r.getRequiredTools()
    const msg = await r.getMessage()
    assert(requiredTools !== undefined, "流式也解析出 requiredTools")
    assert(requiredTools![0]!.tool_call_id === "call_x", "流式 tool_call_id 正确")
    assert(requiredTools![0]!.args.a === 4, "分片 arguments 解析 a=4")
    assert(requiredTools![0]!.args.b === 10, "分片 arguments 解析 b=10")
    assert(msg.tool_calls?.[0]!.function.arguments === '{"a":4,"b":10}', "完整 arguments JSON 拼接正确")

    const ret = await requiredTools![0]!.tool.execute()
    assert(ret === 14, "execute(分片 args) 返回 14")
  } finally {
    server.close()
  }
}

// ============================================================
// 测试 4: 错误重试 + 指数退避
// ============================================================
async function testRetry() {
  console.log("\n[T4] 错误重试（HTTP 500 → 200）")
  let attempts = 0
  const server = await startMockServer(async () => {
    attempts++
    if (attempts < 3) return new Response("err", { status: 500 })
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  })

  try {
    const config = aiSdk.defineConfig({
      modelId: "m",
      apiURL: server.url,
      apiKey: "k",
      stream: false,
      retryTimes: 3,
      exponentialBackoff: true,
      timeout: 5000,
    })
    const inst = aiSdk.defineAi(config, [])
    const r = await inst.request([{ role: "user", content: "" }])
    assert(attempts === 3, `前 2 次 500，第 3 次成功（实际 ${attempts}）`)
    assert(r.message.content === "ok", "最终拿到 200 内容")
  } finally {
    server.close()
  }
}

// ============================================================
// 测试 5: 全部失败 → AIError
// ============================================================
async function testAllFail() {
  console.log("\n[T5] 全部重试失败抛 AIError")
  const server = await startMockServer(async () => new Response("err", { status: 500 }))
  try {
    const config = aiSdk.defineConfig({
      modelId: "m",
      apiURL: server.url,
      apiKey: "k",
      stream: false,
      retryTimes: 1,
      exponentialBackoff: false,
      timeout: 5000,
    })
    const inst = aiSdk.defineAi(config, [])
    let threw: unknown
    try {
      await inst.request([{ role: "user", content: "" }])
    } catch (e) {
      threw = e
    }
    assert(threw instanceof AIError, "抛出 AIError")
    assert(/All 2 attempts failed/.test((threw as Error).message), "错误信息含尝试次数")
  } finally {
    server.close()
  }
}

// ============================================================
// 测试 6: name 缺失抛错
// ============================================================
async function testToolNameMissing() {
  console.log("\n[T6] tool name 缺失 → AIError")
  let threw: unknown
  try {
    // 匿名箭头函数赋给对象属性，name 自动是 "output"，被 SDK 视为无效
    aiSdk.defineTool({
      input: { x: { type: "number", description: "" } },
      output: (x: number) => x,
    })
  } catch (e) {
    threw = e
  }
  assert(threw instanceof AIError, "匿名箭头函数（name=output）触发 AIError")
}

// ============================================================
// 测试 7: customBodyConfig / customHeaderConfig
// ============================================================
async function testCustomConfig() {
  console.log("\n[T7] customBodyConfig / customHeaderConfig")
  let receivedBody: any
  let receivedHeaders: Record<string, string> = {}
  const server = await startMockServer(async (req) => {
    receivedBody = await req.json()
    receivedHeaders = Object.fromEntries(req.headers.entries())
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    })
  })

  try {
    const config = aiSdk.defineConfig({
      modelId: "m",
      apiURL: server.url,
      apiKey: "k",
      stream: false,
      retryTimes: 0,
      customBodyConfig: {
        temperature: 0.7,
        max_tokens: 1024,
        model: "OVERRIDE_MODEL", // 应该覆盖 modelId
      },
      customHeaderConfig: {
        "X-Foo": "bar",
        Authorization: "Bearer CUSTOM_TOKEN", // 应该覆盖默认
      },
    })
    const inst = aiSdk.defineAi(config, [])
    await inst.request([{ role: "user", content: "" }])

    assert(receivedBody.temperature === 0.7, "customBody.temperature 被合并")
    assert(receivedBody.max_tokens === 1024, "customBody.max_tokens 被合并")
    assert(receivedBody.model === "OVERRIDE_MODEL", "customBody.model 覆盖 modelId")
    assert(receivedBody.messages !== undefined, "SDK 默认 body 字段保留")
    assert(receivedBody.stream === false, "SDK 默认 stream 字段保留")

    assert(receivedHeaders["x-foo"] === "bar", "customHeader 被合并")
    assert(receivedHeaders["authorization"] === "Bearer CUSTOM_TOKEN", "customHeader 覆盖默认 Authorization")
  } finally {
    server.close()
  }
}

// ============================================================
// 跑测试
// ============================================================
await testNonStreamingWithTool()
await testStreamingContent()
await testStreamingToolCall()
await testRetry()
await testAllFail()
await testToolNameMissing()
await testCustomConfig()

console.log(`\n========================================`)
console.log(`通过 ${pass} 项, 失败 ${fail} 项`)
console.log(`========================================`)
if (fail > 0) process.exit(1)
