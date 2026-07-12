/**
 * E11.4 — SKILL.md frontmatter parsing. Expects YAML frontmatter (flat key-value pairs) +
 * markdown body. Returns `null` on malformed input (tolerance rule: one bad skill file
 * must never break composition for the whole agent). No dependencies — simple line-by-line
 * parse between `---` delimiters.
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parses a SKILL.md file (YAML frontmatter + markdown body).
 * Required frontmatter: `name`, `description` (flat key-value pairs, one per line).
 * Optional fields are ignored (tolerance rule). Returns `null` if malformed.
 */
export function parseSkillFile(content: string): Skill | null {
  try {
    const lines = content.split("\n");
    if (lines.length < 3 || lines[0] !== "---") {
      return null;
    }

    // Find closing ---
    let frontmatterEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        frontmatterEnd = i;
        break;
      }
    }

    if (frontmatterEnd === -1) {
      return null;
    }

    // Parse frontmatter: flat key: value pairs (simple line-by-line, handle quoted values)
    const frontmatter: Record<string, string> = {};
    for (let i = 1; i < frontmatterEnd; i++) {
      const line = lines[i];
      if (!line) continue;
      const match = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (!match || match.length < 3 || !match[1] || !match[2]) continue;
      let value = match[2].trim();
      if (!value) continue;
      // Strip quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[match[1]] = value;
    }

    // Validate required fields
    if (!frontmatter.name || !frontmatter.description) {
      return null;
    }

    // Body is everything after the closing ---
    const body = lines.slice(frontmatterEnd + 1).join("\n").trim();

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      body,
    };
  } catch {
    return null;
  }
}
