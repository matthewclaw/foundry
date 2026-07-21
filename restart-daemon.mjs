#!/usr/bin/env node
/**
 * Dev helper: rebuild the workspace and bounce the Foundry daemon.
 *
 *   node restart-daemon.mjs [--dir <data-dir>]
 *
 * Defaults to the ./.foundry data dir (README's convention). Build failure aborts
 * before touching the running daemon; a "not running" stop is ignored.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url)); // this file lives at the repo root
const dirFlag = process.argv.indexOf("--dir");
const dataDir = dirFlag !== -1 ? process.argv[dirFlag + 1] : ".foundry";
const cli = join(root, "packages", "cli", "dist", "foundry.js");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  return spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts }).status ?? 1;
}

// 1. Rebuild every package in dependency order (this compiles the runtime fix + the CLI
//    this script then calls). Narrow to `pnpm --filter @foundry/runtime... build` if you
//    only touched the runtime and want it faster.
if (run("pnpm", ["run", "build"], { shell: true }) !== 0) {
  console.error("\nBuild failed — daemon left untouched.");
  process.exit(1);
}

// 2. Ensure the data dir is initialized (idempotent — only writes foundry.config.json
//    when it's missing, never touches existing data). Lets a fresh checkout start clean.
run(process.execPath, [cli, "init", "--dir", dataDir]);

// 3. Stop the old daemon (a stale/absent pidfile is fine — ignore its exit code).
run(process.execPath, [cli, "daemon", "stop", "--dir", dataDir]);

// 4. Start fresh — prints the base URL (e.g. http://127.0.0.1:4180) on success.
process.exit(run(process.execPath, [cli, "daemon", "start", "--dir", dataDir]));
