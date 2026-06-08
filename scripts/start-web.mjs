import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function checkPort(port) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300); // 300ms 超时

    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data && data.name === "token-speed-tester" && data.pid) {
        return { status: "self", pid: data.pid };
      }
    }
    return { status: "occupied" };
  } catch (err) {
    if (err.name === "AbortError") {
      return { status: "occupied" }; // 超时通常说明有服务占用但非我们的服务
    }
    // 比如 ECONNREFUSED，说明端口没有被占用
    return { status: "free" };
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  let port = 3000;
  const maxAttempts = 10;
  let attempts = 0;

  while (attempts < maxAttempts) {
    console.log(`🔍 正在检查端口 ${port} 的占用状态...`);
    const check = await checkPort(port);

    if (check.status === "free") {
      console.log(`🟢 端口 ${port} 空闲，正在启动应用...`);
      break;
    } else if (check.status === "self") {
      console.log(`⚠️ 检测到端口 ${port} 被旧的 token-speed-tester 进程 (PID: ${check.pid}) 占用。`);
      console.log(`正在终止旧进程以重新部署...`);
      try {
        process.kill(check.pid, "SIGTERM");
        // 循环等待端口释放最多 2 秒
        let freed = false;
        for (let i = 0; i < 10; i++) {
          await sleep(200);
          const recheck = await checkPort(port);
          if (recheck.status === "free") {
            freed = true;
            break;
          }
        }
        if (freed) {
          console.log(`🟢 旧进程已成功退出，端口 ${port} 释放成功！`);
          break;
        } else {
          console.log(`🚨 旧进程终止超时，执行强制杀除 (SIGKILL)...`);
          process.kill(check.pid, "SIGKILL");
          await sleep(500);
          break;
        }
      } catch (e) {
        console.log(`❌ 终止旧进程失败: ${e.message}。尝试下一个端口...`);
        port++;
        attempts++;
      }
    } else {
      console.log(`❌ 端口 ${port} 被其他应用占用（非 token-speed-tester）。寻找下一个端口...`);
      port++;
      attempts++;
    }
  }

  // 启动 tsx src/server.ts 进程
  const projectRoot = join(__dirname, "..");
  
  console.log(`🚀 启动 WebUI 进程，绑定端口: ${port}`);
  
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT_OVERRIDE: port.toString(),
    },
  });

  child.on("error", (err) => {
    console.error("❌ 启动子进程失败:", err);
  });
}

start();
