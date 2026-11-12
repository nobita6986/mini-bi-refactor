import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const host = "127.0.0.1";
const startupTimeoutMs = 30_000;

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a local port for the production smoke test");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

const port = await reservePort();
const child = spawn(
  process.execPath,
  [
    "--max-http-header-size=32768",
    path.resolve("node_modules/next/dist/bin/next"),
    "start",
    "--hostname",
    host,
    "--port",
    String(port),
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: process.env },
);

let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-8_000);
  });
}

try {
  const deadline = Date.now() + startupTimeoutMs;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production server exited with code ${child.exitCode}`);
    }
    try {
      response = await fetch(`http://${host}:${port}/login`, {
        signal: AbortSignal.timeout(1_000),
      });
      break;
    } catch {
      await delay(250);
    }
  }

  if (!response) {
    throw new Error(`Production server did not become ready within ${startupTimeoutMs}ms`);
  }
  if (response.status !== 200) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`GET /login returned HTTP ${response.status}: ${body}`);
  }

  const cookie10Kb = `sb-smoke-10k=${"x".repeat(10_240)}`;
  const res10Kb = await fetch(`http://${host}:${port}/login`, {
    headers: { Cookie: cookie10Kb },
    signal: AbortSignal.timeout(2_000),
  });
  if (res10Kb.status !== 200) {
    throw new Error(`GET /login with ~10 KB Cookie returned HTTP ${res10Kb.status}, expected 200`);
  }

  const cookie18Kb = `sb-smoke-18k=${"x".repeat(18_432)}`;
  const res18Kb = await fetch(`http://${host}:${port}/login`, {
    headers: { Cookie: cookie18Kb },
    signal: AbortSignal.timeout(2_000),
  });
  if (res18Kb.status !== 200) {
    throw new Error(`GET /login with ~18 KB Cookie returned HTTP ${res18Kb.status}, expected 200`);
  }

  const cookie36Kb = `sb-smoke-36k=${"x".repeat(36_864)}`;
  const res36Kb = await fetch(`http://${host}:${port}/login`, {
    headers: { Cookie: cookie36Kb },
    signal: AbortSignal.timeout(2_000),
  });
  if (res36Kb.status !== 431) {
    throw new Error(`GET /login with ~36 KB Cookie returned HTTP ${res36Kb.status}, expected 431`);
  }

  console.log(
    `Production server started and GET /login passed header checks (base=${response.status}, 10KB=${res10Kb.status}, 18KB=${res18Kb.status}, 36KB=${res36Kb.status})`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (output.trim()) console.error(output.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5_000),
    ]);
  }
}
