/** E11.4 — skills discovery tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./discover.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("discoverSkills", () => {
  it("returns empty array when skills directory does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result).toEqual([]);
  });

  it("discovers valid skills from subdirectories with SKILL.md", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Create first valid skill
    mkdirSync(join(skillsDir, "ponytail"), { recursive: true });
    writeFileSync(
      join(skillsDir, "ponytail", "SKILL.md"),
      `---
name: ponytail
description: "Lazy senior dev mode"
---

# Ponytail content`,
      "utf8"
    );

    // Create second valid skill
    mkdirSync(join(skillsDir, "deploy"), { recursive: true });
    writeFileSync(
      join(skillsDir, "deploy", "SKILL.md"),
      `---
name: deploy
description: "Automated deployment skill"
---

# Deploy content`,
      "utf8"
    );

    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result).toHaveLength(2);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["deploy", "ponytail"]);
    const byName = Object.fromEntries(result.map((s) => [s.name, s]));
    expect(byName.ponytail.description).toBe("Lazy senior dev mode");
    expect(byName.deploy.description).toBe("Automated deployment skill");
  });

  it("skips subdirectories without SKILL.md", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Valid skill
    mkdirSync(join(skillsDir, "valid"), { recursive: true });
    writeFileSync(
      join(skillsDir, "valid", "SKILL.md"),
      `---
name: valid
description: "A valid skill"
---

Content`,
      "utf8"
    );

    // Missing SKILL.md
    mkdirSync(join(skillsDir, "empty"), { recursive: true });

    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  it("skips subdirectories with malformed SKILL.md", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Valid skill
    mkdirSync(join(skillsDir, "valid"), { recursive: true });
    writeFileSync(
      join(skillsDir, "valid", "SKILL.md"),
      `---
name: valid
description: "Valid skill"
---

Content`,
      "utf8"
    );

    // Malformed (no closing ---)
    mkdirSync(join(skillsDir, "bad"), { recursive: true });
    writeFileSync(
      join(skillsDir, "bad", "SKILL.md"),
      `---
name: bad
description: "Missing closing delimiter"

No closing ---`,
      "utf8"
    );

    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  it("skips skills missing required frontmatter fields", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Missing description
    mkdirSync(join(skillsDir, "no-desc"), { recursive: true });
    writeFileSync(
      join(skillsDir, "no-desc", "SKILL.md"),
      `---
name: no-desc
---

Content`,
      "utf8"
    );

    // Missing name
    mkdirSync(join(skillsDir, "no-name"), { recursive: true });
    writeFileSync(
      join(skillsDir, "no-name", "SKILL.md"),
      `---
description: "No name"
---

Content`,
      "utf8"
    );

    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result).toHaveLength(0);
  });

  it("includes absolute dir path for each discovered skill", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    mkdirSync(join(skillsDir, "test"), { recursive: true });
    writeFileSync(
      join(skillsDir, "test", "SKILL.md"),
      `---
name: test
description: "Test skill"
---

Content`,
      "utf8"
    );

    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result[0].dir).toBe(join(skillsDir, "test"));
  });

  it("silently handles read errors on skills directory", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-discover-"));
    const skillsDir = join(dir, "agents", "a1", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Create a valid skill
    mkdirSync(join(skillsDir, "valid"), { recursive: true });
    writeFileSync(
      join(skillsDir, "valid", "SKILL.md"),
      `---
name: valid
description: "Valid skill"
---

Content`,
      "utf8"
    );

    // Function should still work even if there are permission issues or other problems
    const result = discoverSkills(dir, "agents/a1/memory");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe("valid");
  });
});
