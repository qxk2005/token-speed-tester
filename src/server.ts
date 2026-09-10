import { existsSync, promises as fs, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { extractChunkText } from "./client.js";
import { calculateMetrics, calculateStats } from "./metrics.js";
import { createTokenizer } from "./tokenizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 简易的 yaml 序列化与解析器（严格仅存本地，受 .gitignore 保护）
export function formatYamlConfig(config: Record<string, unknown>): string {
  const lines: string[] = [
    "# Token Speed Tester 本地配置文件（此文件受 .gitignore 保护，绝不上载 Git/GitHub）",
    `# 保存时间: ${new Date().toLocaleString()}`,
    "",
  ];

  const allowedKeys = ["provider", "apiKey", "baseURL", "model", "maxTokens", "runs", "prompt"];
  for (const key of allowedKeys) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== "") {
      const val = String(config[key]);
      lines.push(`${key}: ${JSON.stringify(val)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseLocalYaml(): Record<string, string> {
  const yamlPath = join(__dirname, "..", "config.yaml");
  if (!existsSync(yamlPath)) return {};
  try {
    const content = readFileSync(yamlPath, "utf-8");
    const config: Record<string, string> = {};
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx !== -1) {
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
          try {
            value = JSON.parse(value);
          }
          catch {
            value = value.slice(1, -1);
          }
        }
        config[key] = value;
      }
    }
    return config;
  }
  catch {
    return {};
  }
}

interface SSEWriter {
  write: (chunk: string) => boolean | void;
}

// 原生的 SSE 协议推送辅助函数
function sendSSE(res: SSEWriter, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runSingleWebTest(
  res: SSEWriter,
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
  const sampleChunks: string[] = [];

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
        if (sampleChunks.length < 3) {
          try {
            sampleChunks.push(JSON.stringify(chunk));
          }
          catch {
            // ignore serialization error
          }
        }

        const { text, isReasoning } = extractChunkText(chunk.choices[0]);
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
            isReasoning,
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
        if (sampleChunks.length < 3) {
          try {
            sampleChunks.push(JSON.stringify(event));
          }
          catch {
            // ignore
          }
        }

        let text = "";
        let isReasoning = false;

        if (event.type === "content_block_delta") {
          const delta = event.delta as unknown as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            text = delta.text;
            isReasoning = false;
          }
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            text = delta.thinking;
            isReasoning = true;
          }
        }

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
            isReasoning,
            tps: tokenCount / ((currentTime - startTime) / 1000),
          });
        }
      }
    }

    if (tokenCount === 0) {
      sendSSE(res, {
        type: "diagnostic",
        run: runIndex,
        message: "未从模型流式响应中解析到任何有效 Token 数据（总生成 Tokens 为 0）",
        samples: sampleChunks.slice(0, 2),
        tips: [
          "1. 若使用的是深度思考模型，请确认「最大 Token 数 (Max Tokens)」是否足够大（思考过程可能消耗数百至上千 Token）；",
          "2. 请检查节点端点（Base URL）是否开启了代理缓冲（未启用无缓冲实时流式传输）；",
          "3. 请检查该模型或网关是否直接返回了非标准数据格式或报错响应。",
        ],
      });
    }
  }
  catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`[Run ${runIndex}] ${msg}`);
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
        let html = await fs.readFile(filePath, "utf-8");

        const localConfig = parseLocalYaml();
        const injectScript = `<script>window.LOCAL_CONFIG = ${JSON.stringify(localConfig)};</script>`;
        html = html.replace("<head>", `<head>\n  ${injectScript}`);

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

  // 配置保存接口：仅保存到本地 config.yaml（受 .gitignore 保护）
  if (req.method === "POST" && req.url === "/api/config") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== "object" || !parsed) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        const yamlContent = formatYamlConfig(parsed as Record<string, unknown>);
        const yamlPath = join(__dirname, "..", "config.yaml");
        await fs.writeFile(yamlPath, yamlContent, "utf-8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "配置已成功保存至本地 config.yaml" }));
      }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  // 配置清除接口：删除本地 config.yaml
  if (req.method === "DELETE" && req.url === "/api/config") {
    try {
      const yamlPath = join(__dirname, "..", "config.yaml");
      if (existsSync(yamlPath)) {
        await fs.unlink(yamlPath);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "本地 config.yaml 已成功删除" }));
    }
    catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
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
          catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            sendSSE(res, { type: "error", message: msg });
            res.end();
            return;
          }
        }

        // 计算汇总统计
        const stats = calculateStats(allRunMetrics);
        sendSSE(res, { type: "done", stats });
        res.end();
      }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
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

server.on("error", (err: NodeJS.ErrnoException) => {
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
