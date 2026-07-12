/**
 * E11.4 — skills discovery: list agent's skills from disk.
 * Each subdirectory of `agents/<id>/skills/` that contains a `SKILL.md` is one skill.
 * Skips (doesn't crash on) missing/malformed skills.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillFile } from "./parse.js";

export interface DiscoveredSkill {
  name: string;
  description: string;
  dir: string;
}

/**
 * Lists all valid skills in the agent's skills directory.
 * @param dataDir Server's dataDir
 * @param memoryRef Agent's memory_ref (e.g., "agents/a1/memory")
 * @returns Array of discovered skills (name, description, dir path), skipping invalid ones
 */
export function discoverSkills(dataDir: string, memoryRef: string): DiscoveredSkill[] {
  // Skills dir is a sibling of memory dir: agents/<id>/skills/
  const skillsDir = resolve(dataDir, memoryRef.replace(/[\\/]memory$/, ""), "skills");

  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: DiscoveredSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(skillsDir, entry.name);
      const skillFile = join(skillPath, "SKILL.md");

      if (!existsSync(skillFile)) continue;

      try {
        const content = readFileSync(skillFile, "utf8");
        const parsed = parseSkillFile(content);
        if (parsed) {
          skills.push({
            name: parsed.name,
            description: parsed.description,
            dir: skillPath,
          });
        }
      } catch {
        // Skip this skill directory silently
      }
    }
  } catch {
    // Skills dir exists but couldn't be read — return empty list
  }

  return skills;
}
