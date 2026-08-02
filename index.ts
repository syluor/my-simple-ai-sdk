/**
 * @aderaaaa/ai-sdk 使用示例
 *
 * 配置好 API_KEY 与 apiURL 后即可运行：
 *   bun run index.ts
 *
 * 完整的 multi-turn tool-use 循环：发送问题 → LLM 触发工具调用 →
 * 执行工具回推 → LLM 给出最终答案。
 */
import { aiSdk } from "./src/index"
import dotenv from "dotenv"

dotenv.config()


const config1 = aiSdk.defineConfig({
  modelId: "deepseek-v4-flash",
  apiURL: "https://api.deepseek.com/chat/completions",
  apiKey: process.env.API_KEY ?? "",
  // 以下全部可选
  stream: true,
  retryTimes: 3,
  exponentialBackoff: true, // "指数回避" 的英文名
  timeout: 30_000, // 单次请求超时，毫秒
})

const add = aiSdk.defineTool({
  name: "add",
  description: "整数加法",
  input: {
    a: { type: "number", description: "第一个加数" },
    b: { type: "number", description: "第二个加数", required: false },
  },
  output: (a: number, b: number) => a + b,
})

const ai1 = aiSdk.defineAi(config1, [add])

const messages: aiSdk.Messages = [
  { role: "system", content: "你是一个助手" },
  { role: "user", content: "生成500字小说以供测试" },
]

while (true) {
  const result = await ai1.request(messages)

  // 真·实时流式输出（边到边吐，不再是"等完一股脑"）
  for await (const chunk of result.stream) {
    process.stdout.write(chunk)
  }

  messages.push(await result.getMessage())

  // 触发了工具调用：执行并把结果回推，继续多轮
  const requiredTools = await result.getRequiredTools()
  if (requiredTools && requiredTools.length > 0) {
    for (const rt of requiredTools) {
      const ret = await rt.tool.execute() // 已绑定 args，无参调用
      messages.push({
        role: "tool",
        tool_call_id: rt.tool_call_id,
        content: String(ret),
      })
    }
    continue
  }

  // 没有工具调用：流式输出已看完，退出
  console.log()
  break
}
