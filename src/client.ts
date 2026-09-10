import type { Config } from "./config.js";
import type { StreamMetrics } from "./metrics.js";
import { performance } from "node:perf_hooks";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getMessages } from "./i18n.js";
import { createTokenizer } from "./tokenizer.js";

interface StreamResult {
  ttft: number;
  tokens: number[];
  totalTokens: number;
  totalTime: number;
}

interface StreamProcessor {
  stream: () => AsyncIterable<{ text: string }>;
  providerName: string;
}

class AnthropicStreamProcessor implements StreamProcessor {
  providerName = "Anthropic" as const;

  constructor(
    private client: Anthropic,
    private config: Config,
  ) {}

  async* stream(): AsyncIterable<{ text: string }> {
    const stream = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [{ role: "user", content: this.config.prompt }],
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta as unknown as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          yield { text: delta.text };
        }
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
          yield { text: delta.thinking };
        }
      }
    }
  }
}

export function extractChunkText(choice?: unknown): { text: string; isReasoning: boolean } {
  if (!choice || typeof choice !== "object") {
    return { text: "", isReasoning: false };
  }

  const c = choice as Record<string, unknown>;
  const delta = (c.delta && typeof c.delta === "object") ? (c.delta as Record<string, unknown>) : undefined;

  if (delta) {
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      return { text: delta.reasoning_content, isReasoning: true };
    }
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      return { text: delta.reasoning, isReasoning: true };
    }
    if (typeof delta.thought === "string" && delta.thought.length > 0) {
      return { text: delta.thought, isReasoning: true };
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      return { text: delta.content, isReasoning: false };
    }
  }

  if (typeof c.text === "string" && c.text.length > 0) {
    return { text: c.text, isReasoning: false };
  }

  const message = (c.message && typeof c.message === "object") ? (c.message as Record<string, unknown>) : undefined;
  if (message && typeof message.content === "string" && message.content.length > 0) {
    return { text: message.content, isReasoning: false };
  }

  return { text: "", isReasoning: false };
}

class OpenAIStreamProcessor implements StreamProcessor {
  providerName = "OpenAI" as const;

  constructor(
    private client: OpenAI,
    private config: Config,
  ) {}

  async* stream(): AsyncIterable<{ text: string }> {
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [{ role: "user", content: this.config.prompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      const { text } = extractChunkText(chunk.choices[0]);
      if (text) {
        yield { text };
      }
    }
  }
}

async function runStreamTest(
  processor: StreamProcessor,
  startTime: number,
  encoding: ReturnType<typeof createTokenizer>,
): Promise<StreamResult> {
  const tokenTimes: number[] = [];
  let ttft = 0;
  let firstTokenRecorded = false;
  let tokenCount = 0;
  let wroteOutput = false;

  try {
    for await (const { text } of processor.stream()) {
      if (text.length > 0) {
        process.stdout.write(text);
        wroteOutput = true;

        const encoded = encoding.encode(text);
        const newTokens = encoded.length;

        if (newTokens > 0) {
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
        }
      }
    }
  }
  catch (error) {
    if (error instanceof Error) {
      throw new Error(`${processor.providerName} API error: ${error.message}`);
    }
    throw error;
  }
  finally {
    if (wroteOutput) {
      process.stdout.write("\n");
    }
    encoding.free();
  }

  const endTime = performance.now();

  return {
    ttft,
    tokens: tokenTimes,
    totalTokens: tokenCount,
    totalTime: endTime - startTime,
  };
}

/**
 * 执行 Anthropic API 流式测试
 */
export async function anthropicStreamTest(config: Config): Promise<StreamMetrics> {
  const startTime = performance.now();
  const encoding = createTokenizer(config.model);
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const processor = new AnthropicStreamProcessor(client, config);
  return runStreamTest(processor, startTime, encoding);
}

/**
 * 执行 OpenAI API 流式测试
 */
export async function openaiStreamTest(config: Config): Promise<StreamMetrics> {
  const startTime = performance.now();
  const encoding = createTokenizer(config.model);
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const processor = new OpenAIStreamProcessor(client, config);
  return runStreamTest(processor, startTime, encoding);
}

/**
 * 根据配置执行流式测试
 */
export async function streamTest(config: Config): Promise<StreamMetrics> {
  if (config.provider === "anthropic") {
    return anthropicStreamTest(config);
  }
  else {
    return openaiStreamTest(config);
  }
}

/**
 * 执行多次测试
 */
export async function runMultipleTests(config: Config): Promise<StreamMetrics[]> {
  const results: StreamMetrics[] = [];
  const messages = getMessages(config.lang);

  for (let i = 0; i < config.runCount; i++) {
    if (config.runCount > 1) {
      const label = `\n${messages.runProgressLabel(i + 1, config.runCount)}`;
      console.log(label);
      console.log("-".repeat(label.length - 1));
    }
    const result = await streamTest(config);
    results.push(result);
  }

  return results;
}
