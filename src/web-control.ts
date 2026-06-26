import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 3000;
const MAX_PORT_ATTEMPTS = 10;
const HEALTH_TIMEOUT_MS = 300;

interface HealthInfo {
  name: string;
  pid: number;
}

type PortStatus
  = | { status: "self"; pid: number }
    | { status: "occupied" }
    | { status: "free" };

function isHealthInfo(value: unknown): value is HealthInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.pid === "number";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 探测端口上是否有服务：
 * - self：是我们自己的 token-speed-tester 进程
 * - occupied：被其他应用占用
 * - free：端口空闲
 */
async function checkPort(port: number): Promise<PortStatus> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data: unknown = await res.json();
      if (isHealthInfo(data) && data.name === "token-speed-tester") {
        return { status: "self", pid: data.pid };
      }
    }
    return { status: "occupied" };
  }
  catch (err) {
    // 超时通常说明端口被某个慢响应的服务占用
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "occupied" };
    }
    // ECONNREFUSED 等说明端口空闲
    return { status: "free" };
  }
}

/**
 * 解析 server 可执行文件及其运行器，使 --restart 同时适用于：
 * - 开发态：当前模块为 .ts（tsx 运行），server 为 src/server.ts，用 npx tsx 运行
 * - 发布态：当前模块为 .mjs（node 运行），server 为 dist/server.mjs，用 node 运行
 */
function resolveServerRunner(): { command: string; args: string[]; cwd: string } {
  const currentFile = fileURLToPath(import.meta.url);
  const ext = extname(currentFile);
  const serverFile = join(dirname(currentFile), `server${ext}`);
  const cwd = join(dirname(currentFile), "..");

  if (ext === ".ts") {
    return { command: "npx", args: ["tsx", serverFile], cwd };
  }
  return { command: process.execPath, args: [serverFile], cwd };
}

/**
 * 以后台守护进程方式启动 server：detached + unref，stdio 重定向到日志文件，
 * 使父进程可以立即退出并归还终端。
 */
function spawnDaemon(port: number, logPath: string): void {
  const { command, args, cwd } = resolveServerRunner();
  const logFd = openSync(logPath, "a");

  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PORT_OVERRIDE: String(port) },
  });

  child.on("error", (err) => {
    console.error(`❌ 启动守护进程失败: ${err.message}`);
  });

  child.unref();
}

/**
 * 终止我们自己旧的 server 进程：先 SIGTERM，超时后 SIGKILL。
 */
async function stopSelf(port: number, pid: number): Promise<void> {
  console.log(`⚠️ 检测到端口 ${port} 被旧的 token-speed-tester 进程 (PID: ${pid}) 占用，正在终止...`);
  try {
    process.kill(pid, "SIGTERM");
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ 发送 SIGTERM 失败: ${message}`);
    return;
  }

  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const recheck = await checkPort(port);
    if (recheck.status === "free") {
      console.log(`🟢 旧进程已退出，端口 ${port} 释放成功。`);
      return;
    }
  }

  console.log(`🚨 旧进程终止超时，执行强制杀除 (SIGKILL)...`);
  try {
    process.kill(pid, "SIGKILL");
  }
  catch {
    // 进程可能已经退出，忽略
  }
  await sleep(500);
}

/**
 * 选定端口：优先复用 3000（杀掉我们自己的旧进程），否则顺延寻找空闲端口。
 */
async function resolvePort(): Promise<number> {
  let port = DEFAULT_PORT;

  for (let attempts = 0; attempts < MAX_PORT_ATTEMPTS; attempts++) {
    console.log(`🔍 正在检查端口 ${port} 的占用状态...`);
    const check = await checkPort(port);

    if (check.status === "free") {
      console.log(`🟢 端口 ${port} 空闲。`);
      return port;
    }
    if (check.status === "self") {
      await stopSelf(port, check.pid);
      return port;
    }

    console.log(`❌ 端口 ${port} 被其他应用占用（非 token-speed-tester），尝试下一个端口...`);
    port++;
  }

  throw new Error(
    `未能在 ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1} 范围内找到可用端口。`,
  );
}

/**
 * 轮询健康检查，等待新 server 就绪，返回其真实 PID（失败返回 null）。
 */
async function waitUntilReady(port: number): Promise<number | null> {
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const check = await checkPort(port);
    if (check.status === "self") {
      return check.pid;
    }
  }
  return null;
}

/**
 * 停止正在运行的 token-speed-tester WebUI server。
 * 从默认端口 3000 开始依次探测，找到属于我们的进程后终止它。
 */
export async function stopWebServer(): Promise<void> {
  let port = DEFAULT_PORT;

  for (let attempts = 0; attempts < MAX_PORT_ATTEMPTS; attempts++) {
    const check = await checkPort(port);

    if (check.status === "self") {
      await stopSelf(port, check.pid);
      console.log(`✅ WebUI server (PID: ${check.pid}) 已停止。`);
      return;
    }

    if (check.status === "free") {
      break;
    }

    // occupied by another app — try next port
    port++;
  }

  console.log(`ℹ️ 未检测到正在运行的 token-speed-tester WebUI server（端口 ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}）。`);
}

/**
 * 重启 WebUI server：停止旧的 token-speed-tester 进程，并以后台守护进程方式
 * 启动新的实例，立即归还终端，日志写入临时目录。
 */
export async function restartWebServer(): Promise<void> {
  const port = await resolvePort();
  const logPath = join(tmpdir(), "token-speed-tester-web.log");

  console.log(`🚀 正在以后台守护进程方式启动 WebUI server，端口: ${port}`);
  console.log(`📄 日志输出: ${logPath}`);

  spawnDaemon(port, logPath);

  const pid = await waitUntilReady(port);
  if (pid !== null) {
    console.log(`✅ WebUI server 已启动 (PID: ${pid})：http://localhost:${port}`);
    console.log(`ℹ️ 进程已在后台运行，可关闭当前终端。停止命令：kill ${pid}`);
  }
  else {
    console.warn(`⚠️ 已发起启动，但未在预期时间内确认健康检查，请查看日志: ${logPath}`);
  }
}

/**
 * 在前台启动 WebUI server：stdio 继承父进程终端，日志直接输出到屏幕，
 * 用户可通过 Ctrl+C 退出。适用于 --start 和 --restart 的前台模式。
 */
export async function startWebServerForeground(): Promise<void> {
  const port = await resolvePort();
  const { command, args, cwd } = resolveServerRunner();

  console.log(`🚀 WebUI server 启动中，端口: ${port}`);
  console.log(`ℹ️ 按 Ctrl+C 退出\n`);

  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PORT_OVERRIDE: String(port) },
  });

  // 将父进程退出信号转发给子进程
  const forwardInt = () => child.kill("SIGINT");
  const forwardTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInt);
  process.on("SIGTERM", forwardTerm);

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      process.off("SIGINT", forwardInt);
      process.off("SIGTERM", forwardTerm);
      // code === null 表示被信号终止（如 Ctrl+C），视为正常退出
      if (code === null || code === 0) {
        resolve();
      }
      else {
        reject(new Error(`WebUI server 退出，exit code: ${code}`));
      }
    });
    child.on("error", (err) => {
      process.off("SIGINT", forwardInt);
      process.off("SIGTERM", forwardTerm);
      reject(err);
    });
  });
}
