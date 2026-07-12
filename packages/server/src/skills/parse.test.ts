/** E11.4 — SKILL.md parsing tests. */
import { describe, expect, it } from "vitest";
import { parseSkillFile } from "./parse.js";

describe("parseSkillFile", () => {
  it("parses valid frontmatter and body", () => {
    const content = `---
name: ponytail
description: "Lazy senior dev mode"
homepage: https://example.com
---

# Ponytail

You are a lazy senior developer...

More details here.`;
    const result = parseSkillFile(content);
    expect(result).toEqual({
      name: "ponytail",
      description: "Lazy senior dev mode",
      body: "# Ponytail\n\nYou are a lazy senior developer...\n\nMore details here.",
    });
  });

  it("handles single-quoted values", () => {
    const content = `---
name: 'my-skill'
description: 'A test skill'
---

Body text`;
    const result = parseSkillFile(content);
    expect(result?.name).toBe("my-skill");
    expect(result?.description).toBe("A test skill");
  });

  it("ignores unknown frontmatter fields (tolerance rule)", () => {
    const content = `---
name: test
description: "A skill"
license: MIT
homepage: https://example.com
unknown_field: value
---

Body`;
    const result = parseSkillFile(content);
    expect(result?.name).toBe("test");
    expect(result?.description).toBe("A skill");
  });

  it("returns null when missing name", () => {
    const content = `---
description: "No name"
---

Body`;
    expect(parseSkillFile(content)).toBeNull();
  });

  it("returns null when missing description", () => {
    const content = `---
name: test
---

Body`;
    expect(parseSkillFile(content)).toBeNull();
  });

  it("returns null when no frontmatter delimiters", () => {
    const content = `name: test
description: "No delimiters"

Body`;
    expect(parseSkillFile(content)).toBeNull();
  });

  it("returns null when closing --- is missing", () => {
    const content = `---
name: test
description: "Unclosed"

Body with no closing delimiter`;
    expect(parseSkillFile(content)).toBeNull();
  });

  it("handles empty body gracefully", () => {
    const content = `---
name: test
description: "Empty body"
---
`;
    const result = parseSkillFile(content);
    expect(result?.body).toBe("");
  });

  it("returns null on exception (catch-all tolerance)", () => {
    // Test catch-all by passing something that isn't a string but the function expects it
    const result = parseSkillFile(null as any);
    expect(result).toBeNull();
  });
});
