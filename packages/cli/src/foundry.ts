#!/usr/bin/env node
/**
 * E5.7 — foundry CLI: init, daemon start/stop, agent create, backup.
 * L4: depends on core only (via HTTP).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { CreateAgentRequestSchema } from "@foundry/core";

const exec = promisify(execFile);

function printError(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printError("Usage: foundry <command> [options]\nCommands: init, daemon, agent, backup");
  }

  const command = args[0];

  switch (command) {
    case "init":
      await handleInit(args.slice(1));
      break;
    case "daemon":
      await handleDaemon(args.slice(1));
      break;
    case "agent":
      await handleAgent(args.slice(1));
      break;
    case "backup":
      await handleBackup(args.slice(1));
      break;
    default:
      printError(`Unknown command: ${command}`);
  }
}

// =============================================================================
// foundry init [--dir <path>]
// =============================================================================

async function handleInit(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
    allowPositionals: false,
  });

  const dir = resolve(parsed.values.dir || "./.foundry");
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, "foundry.config.json");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify({ port: 4180, host: "127.0.0.1" }, null, 2),
      "utf-8"
    );
  }

  console.log(dir);
}

// =============================================================================
// foundry daemon start|stop [--dir <path>]
// =============================================================================

async function handleDaemon(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    printError("Usage: foundry daemon <start|stop> [--dir <path>]");
  }

  const subcommand = argv[0];
  const parsed = parseArgs({
    args: argv.slice(1),
    options: { dir: { type: "string" } },
    allowPositionals: false,
  });

  const dir = resolve(parsed.values.dir || "./.foundry");

  if (subcommand === "start") {
    return daemonStart(dir);
  } else if (subcommand === "stop") {
    return daemonStop(dir);
  } else {
    printError(`Unknown daemon subcommand: ${subcommand}`);
  }
}

async function daemonStart(dir: string): Promise<void> {
  const pidPath = join(dir, "daemon.pid");

  // Check if daemon is already running
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8"), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      printError(`Daemon already running (pid ${pid})`);
    } catch {
      // Process doesn't exist, remove stale pid file
      rmSync(pidPath, { force: true });
    }
  }

  // Locate daemon script
  const daemonPath = locateDaemonScript();

  // Read config to get host:port
  const config = JSON.parse(readFileSync(join(dir, "foundry.config.json"), "utf-8"));
  const host = config.host || "127.0.0.1";
  const port = config.port || 4180;
  const baseUrl = `http://${host}:${port}`;

  // Spawn daemon detached
  const child = execFile("node", [daemonPath, "--data-dir", dir], {
    detached: true,
    stdio: "ignore",
  } as any);

  // Unref to allow parent to exit
  if (child.unref) {
    child.unref();
  }

  // First wait for pidfile to be created (daemon initialized)
  const pidStartTime = Date.now();
  while (!existsSync(pidPath)) {
    if (Date.now() - pidStartTime > 5000) {
      printError("Failed to start daemon: pidfile not created after 5s");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Then poll health endpoint (max 10s)
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        console.log(baseUrl);
        return;
      }
    } catch (err) {
      // Not ready yet; timeout or connection refused is expected
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  printError("Failed to start daemon: health check timeout");
}

async function daemonStop(dir: string): Promise<void> {
  const pidPath = join(dir, "daemon.pid");

  if (!existsSync(pidPath)) {
    printError("Daemon not running (no pid file)");
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8"), 10);

  // Try to kill the process
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process doesn't exist
    rmSync(pidPath, { force: true });
    return;
  }

  // Wait for process to exit (max 5s)
  const startTime = Date.now();
  while (Date.now() - startTime < 5000) {
    try {
      process.kill(pid, 0); // Check if process exists
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      // Process exited
      break;
    }
  }

  rmSync(pidPath, { force: true });
}

// =============================================================================
// foundry agent create --name <n> --role <r> [...options]
// =============================================================================

async function handleAgent(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      role: { type: "string" },
      "charter-file": { type: "string" },
      charter: { type: "string" },
      engine: { type: "string" },
      server: { type: "string" },
      dir: { type: "string" },
    },
    allowPositionals: false,
  });

  const name = parsed.values.name;
  const role = parsed.values.role;

  if (!name || !role) {
    printError("Usage: foundry agent create --name <n> --role <r> [--charter-file <path> | --charter <text>] [--engine <id>] [--server <url>] [--dir <path>]");
  }

  let charterMd: string = "";
  if (parsed.values["charter-file"]) {
    charterMd = readFileSync(parsed.values["charter-file"], "utf-8");
  } else if (parsed.values.charter) {
    charterMd = parsed.values.charter;
  } else {
    printError("Either --charter-file or --charter is required");
  }

  const engine = parsed.values.engine || "fake";
  const dir = resolve(parsed.values.dir || "./.foundry");
  let serverUrl = parsed.values.server;

  if (!serverUrl) {
    const config = JSON.parse(readFileSync(join(dir, "foundry.config.json"), "utf-8"));
    const host = config.host || "127.0.0.1";
    const port = config.port || 4180;
    serverUrl = `http://${host}:${port}`;
  }

  const request = {
    name,
    role,
    charter_md: charterMd,
    engine: { id: engine },
  };

  // Validate with core schema
  const validated = CreateAgentRequestSchema.parse(request);

  const res = await fetch(`${serverUrl}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });

  if (!res.ok) {
    const text = await res.text();
    printError(`Failed to create agent: ${res.status} ${text}`);
  }

  const result = await res.json();
  console.log((result as any).id || (result as any).agentId);
}

// =============================================================================
// foundry backup --dest <path> [--dir <path>] [--server <url>]
// =============================================================================

async function handleBackup(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      dest: { type: "string" },
      dir: { type: "string" },
      server: { type: "string" },
    },
    allowPositionals: false,
  });

  const dest = parsed.values.dest;
  if (!dest) {
    printError("Usage: foundry backup --dest <path> [--dir <path>] [--server <url>]");
  }

  const dir = resolve(parsed.values.dir || "./.foundry");
  let serverUrl = parsed.values.server;

  if (!serverUrl) {
    const config = JSON.parse(readFileSync(join(dir, "foundry.config.json"), "utf-8"));
    const host = config.host || "127.0.0.1";
    const port = config.port || 4180;
    serverUrl = `http://${host}:${port}`;
  }

  const res = await fetch(`${serverUrl}/api/backup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dest }),
  });

  if (!res.ok) {
    const text = await res.text();
    printError(`Backup failed: ${res.status} ${text}`);
  }

  const result = await res.json();
  console.log(JSON.stringify(result, null, 2));
}

// =============================================================================
// Helpers
// =============================================================================

function locateDaemonScript(): string {
  // First: check env var
  const envPath = process.env.FOUNDRY_DAEMON_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Second: walk up from cwd looking for node_modules/@foundry/server/dist/daemon.js
  let current = process.cwd();
  while (current !== "/") {
    const path = join(current, "node_modules", "@foundry", "server", "dist", "daemon.js");
    if (existsSync(path)) {
      return path;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  // Third: check packages/server/dist/daemon.js relative to repo root
  // (This is a heuristic; we assume we're run from somewhere in the repo)
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const path = join(repoRoot, "packages", "server", "dist", "daemon.js");
    if (existsSync(path)) {
      return path;
    }
  }

  printError("Could not locate daemon script. Set FOUNDRY_DAEMON_PATH env var.");
}

function findRepoRoot(): string | null {
  let current = process.cwd();
  while (current !== "/") {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
