import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devServerPort = 5178;
const devServerUrl = `http://localhost:${devServerPort}`;
const preloadSource = path.join(projectRoot, "src", "preload", "preload.cjs");
const preloadDestination = path.join(projectRoot, "dist-electron", "preload", "preload.cjs");

function forward(tag, stream) {
  stream.setEncoding("utf8");
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) console.log(`${tag} ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending.length > 0) console.log(`${tag} ${pending}`);
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  child.kill();
  if (pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  }
}

async function waitForDevServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return false;
}

if (!existsSync(preloadDestination)) {
  await mkdir(path.dirname(preloadDestination), { recursive: true });
  await copyFile(preloadSource, preloadDestination);
}

const viteProcess = spawn("npx.cmd", ["vite", "--port", String(devServerPort), "--strictPort"], {
  cwd: projectRoot,
  env: process.env,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
forward("[vite]", viteProcess.stdout);
forward("[vite]", viteProcess.stderr);

let electronProcess = null;

viteProcess.on("exit", (code) => {
  if (electronProcess === null) {
    console.error(`[vite] exited before electron started (code ${code})`);
    process.exit(code ?? 1);
  }
  killTree(electronProcess);
  process.exit(code ?? 1);
});

const serverReady = await waitForDevServer(devServerUrl, 30000);
if (!serverReady) {
  console.error(`[dev] dev server did not respond within 30s: ${devServerUrl}`);
  killTree(viteProcess);
  process.exit(1);
}

const electronBinary = require("electron");
electronProcess = spawn(electronBinary, ["."], {
  cwd: projectRoot,
  env: { ...process.env, QUILL_VITE_URL: devServerUrl },
  stdio: ["inherit", "pipe", "pipe"],
});
forward("[electron]", electronProcess.stdout);
forward("[electron]", electronProcess.stderr);

electronProcess.on("exit", (code) => {
  killTree(viteProcess);
  setTimeout(() => process.exit(code ?? 0), 500);
});

process.on("SIGINT", () => {
  killTree(electronProcess);
  killTree(viteProcess);
  setTimeout(() => process.exit(130), 500);
});
