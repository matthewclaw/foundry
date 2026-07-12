#!/usr/bin/env node
/**
 * E5.7 — daemon runnable composition root. Reads config from argv or foundry.config.json,
 * creates the server with fake adapter, starts listening, and writes the pid file.
 * The CLI (L4) spawns this and parses the JSON address from stdout.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "./server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createClaudeCodeAdapter } from "@foundry/adapter-claude-code";

interface Config {
  dataDir: string;
  port?: number;
  host?: string;
  dbPath?: string;
}

async function main() {
  const args = parseArgs({
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "db-path": { type: "string" },
    },
  });

  const dataDir = args.values["data-dir"] || process.cwd();
  let config: Config = {
    dataDir,
  };

  // Try to load foundry.config.json from dataDir
  try {
    const configPath = join(dataDir, "foundry.config.json");
    const configText = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(configText);
    config = { ...parsed, ...config };
  } catch {
    // Ignore if config file doesn't exist
  }

  // Override with CLI args
  if (args.values.port) config.port = parseInt(args.values.port, 10);
  if (args.values.host) config.host = args.values.host;
  if (args.values["db-path"]) config.dbPath = args.values["db-path"];

  const server = createServer({
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    host: config.host || "127.0.0.1",
    port: config.port || 4180,
    adapters: {
      fake: createFakeAdapter(loadScenario("happy-path")),
      // Headless CLI has no TTY to approve tool calls interactively, so the first
      // write/exec would otherwise abort the run (adapter README, E9.4 approvals
      // aren't wired into the CLI's own prompts yet) — acceptEdits pre-approves file
      // edits at the process level; Foundry-side approvals (E9.4) still gate the rest.
      "claude-code": createClaudeCodeAdapter({ permissionMode: "acceptEdits" }),
    },
  });

  const address = await server.start();

  // Write pid file
  const pidPath = join(config.dataDir, "daemon.pid");
  writeFileSync(pidPath, String(process.pid), "utf-8");

  // Print address as JSON for CLI to parse
  console.log(JSON.stringify({ address }));

  // Handle graceful shutdown
  const handleShutdown = async () => {
    try {
      await server.stop();
      rmSync(pidPath, { force: true });
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

main().catch((err) => {
  console.error("Daemon error:", err);
  process.exit(1);
});
