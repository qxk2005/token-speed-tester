import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { calculateMetrics, calculateStats } from "./metrics.js";
import { createTokenizer } from "./tokenizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 原生的 SSE 协议推送辅助函数
function sendSSE(res: any, data: any) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runSingleWebTest(
  res: any,
  runIndex: number,
  config: {
    provider: "openai" | "anthropic";
    apiKey: string;
    baseURL?: string;
    model: string;
    maxTokens: number;
    prompt: string;
  },
) {
  const startTime = performance.now();
  const tokenizer = createTokenizer(config.model);
  const tokenTimes: number[] = [];
  let ttft = 0;
  let firstTokenRecorded = false;
  let tokenCount = 0;

  sendSSE(res, { type: "run_start", run: runIndex });

  try {
    if (config.provider === "openai") {
      const openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      });

      const stream = await openai.chat.completions.create({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content: config.prompt }],
        stream: true,
      });

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          const encoded = tokenizer.encode(text);
          const newTokens = encoded.length;
          const currentTime = performance.now();
          const currentRelTime = currentTime - startTime;

          if (!firstTokenRecorded) {
            ttft = currentRelTime;
            firstTokenRecorded = true;
            for (let i = 0; i < newTokens; i++) {
              tokenTimes.push(currentRelTime);
            }
          }
          else {
            const lastTime = tokenTimes.length > 0 ? tokenTimes[tokenTimes.length - 1] : 0;
            const timeDiff = currentRelTime - lastTime;
            const step = timeDiff / newTokens;
            for (let i = 0; i < newTokens; i++) {
              tokenTimes.push(lastTime + step * (i + 1));
            }
          }
          tokenCount += newTokens;

          sendSSE(res, {
            type: "chunk",
            run: runIndex,
            text,
            tps: tokenCount / ((currentTime - startTime) / 1000),
          });
        }
      }
    }
    else {
      const anthropic = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      });

      const stream = await anthropic.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content: config.prompt }],
        stream: true,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
          && event.delta.text
        ) {
          const text = event.delta.text;
          const encoded = tokenizer.encode(text);
          const newTokens = encoded.length;
          const currentTime = performance.now();
          const currentRelTime = currentTime - startTime;

          if (!firstTokenRecorded) {
            ttft = currentRelTime;
            firstTokenRecorded = true;
            for (let i = 0; i < newTokens; i++) {
              tokenTimes.push(currentRelTime);
            }
          }
          else {
            const lastTime = tokenTimes.length > 0 ? tokenTimes[tokenTimes.length - 1] : 0;
            const timeDiff = currentRelTime - lastTime;
            const step = timeDiff / newTokens;
            for (let i = 0; i < newTokens; i++) {
              tokenTimes.push(lastTime + step * (i + 1));
            }
          }
          tokenCount += newTokens;

          sendSSE(res, {
            type: "chunk",
            run: runIndex,
            text,
            tps: tokenCount / ((currentTime - startTime) / 1000),
          });
        }
      }
    }
  }
  catch (error: any) {
    throw new Error(`[Run ${runIndex}] ${error.message || error}`);
  }
  finally {
    tokenizer.free();
  }

  const endTime = performance.now();
  const rawMetrics = {
    ttft,
    tokens: tokenTimes,
    totalTokens: tokenCount,
    totalTime: endTime - startTime,
  };

  const calculated = calculateMetrics(rawMetrics);
  sendSSE(res, { type: "run_end", run: runIndex, metrics: calculated });
  return calculated;
}

const server = createServer(async (req, res) => {
  // 静态页面托管
  if (req.method === "GET") {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "token-speed-tester", pid: process.pid }));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      try {
        const filePath = join(__dirname, "public", "index.html");
        const html = await fs.readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
    }
  }

  // 跨域处理与 SSE 接口
  if (req.method === "POST" && req.url === "/api/test") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const { provider, apiKey, baseURL, model, maxTokens, runs, prompt } = parsed;

        if (!apiKey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "API Key is required" }));
          return;
        }

        // 设置响应头为 SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        const runCount = Math.max(1, Number.parseInt(runs) || 1);
        const allRunMetrics = [];

        for (let i = 1; i <= runCount; i++) {
          try {
            const calculated = await runSingleWebTest(res, i, {
              provider: provider || "openai",
              apiKey,
              baseURL: baseURL || undefined,
              model: model || "gpt-4o",
              maxTokens: Number.parseInt(maxTokens) || 1024,
              prompt: prompt || "Write a short poem about AI",
            });
            allRunMetrics.push(calculated);
          }
          catch (err: any) {
            sendSSE(res, { type: "error", message: err.message });
            res.end();
            return;
          }
        }

        // 计算汇总统计
        const stats = calculateStats(allRunMetrics);
        sendSSE(res, { type: "done", stats });
        res.end();
      }
      catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

let port = process.env.PORT_OVERRIDE ? Number.parseInt(process.env.PORT_OVERRIDE) : 3000;
function startServer(p: number) {
  server.listen(p, () => {
    console.log(`\n🚀 WebUI Server is running at http://localhost:${p}`);
  });
}

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${port} is in use, trying ${port + 1}...`);
    port++;
    startServer(port);
  }
  else {
    console.error("Server error:", err);
  }
});

startServer(port);
