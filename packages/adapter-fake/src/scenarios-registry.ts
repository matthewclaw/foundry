/**
 * Loads the canned scenario library shipped at `scenarios/*.json` (package root, sibling
 * of `src`/`dist` — so this resolves correctly both against compiled `dist/` and against
 * `src/` directly under Vitest).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioSchema, type Scenario } from "./scenario.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = join(moduleDir, "..", "scenarios");

export function listScenarioNames(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadScenario(name: string): Scenario {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  const raw = readFileSync(path, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`scenario "${name}" is not valid JSON (${path})`, { cause });
  }
  return ScenarioSchema.parse(json);
}

export function loadAllScenarios(): Record<string, Scenario> {
  return Object.fromEntries(listScenarioNames().map((name) => [name, loadScenario(name)]));
}
