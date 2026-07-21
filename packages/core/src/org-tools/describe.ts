/**
 * Human-readable input schemas for the org-tools, DERIVED from the same Zod definitions
 * the server validates against (ORG_TOOL_INPUT_SCHEMAS) — never hand-transcribed, so
 * they can't drift. Used by the CLI shim's `--help` and echoed in the server's
 * invalid-input error, so an agent that guesses a payload wrong (e.g. `summary` vs
 * `summary_md`, or a bare path where a `<kind>:<id>` ref is required) can self-correct
 * from the exact field list instead of brute-forcing it.
 */
import { z } from "zod";
import { ORG_TOOL_INPUT_SCHEMAS, type OrgToolName } from "./schemas.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- walking Zod's internal _def. */

/** Unwrap `.refine()`/`.transform()` (ZodEffects) to the underlying object, if any. */
function unwrapToObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let s: any = schema;
  while (s?._def?.typeName === "ZodEffects") s = s._def.schema;
  return s?._def?.typeName === "ZodObject" ? s : null;
}

/** A short type label for one field — its `.describe()` text if set, else a structural name. */
function label(schema: z.ZodTypeAny): string {
  const s: any = schema;
  if (s?._def?.description) return s._def.description;
  switch (s?._def?.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return label(s._def.innerType);
    case "ZodBranded":
      return label(s._def.type);
    case "ZodEffects":
      return label(s._def.schema);
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodLiteral":
      return JSON.stringify(s._def.value);
    case "ZodEnum":
      return s._def.values.map((v: string) => JSON.stringify(v)).join(" | ");
    case "ZodArray":
      return `${label(s._def.type)}[]`;
    case "ZodObject":
      return `{ ${Object.keys(s._def.shape()).join(", ")} }`;
    default:
      return "value";
  }
}

/** Optional if it's wrapped in `.optional()` or carries a `.default()`. */
function isRequired(schema: z.ZodTypeAny): boolean {
  const tn = (schema as any)?._def?.typeName;
  return tn !== "ZodOptional" && tn !== "ZodDefault";
}

/** Render one org-tool's input as a field list, e.g. for `<tool> --help`. */
export function describeOrgToolInput(name: OrgToolName): string {
  const schema = ORG_TOOL_INPUT_SCHEMAS[name] as z.ZodTypeAny | undefined;
  if (!schema) return `Unknown org-tool: ${name}`;
  const obj = unwrapToObject(schema);
  if (!obj) return `${name}: (no described fields)`;
  const shape = (obj as any)._def.shape();
  const lines = Object.entries(shape).map(
    ([k, v]) => `  ${k}: ${label(v as z.ZodTypeAny)} (${isRequired(v as z.ZodTypeAny) ? "required" : "optional"})`
  );
  return `${name} — input fields:\n${lines.join("\n")}`;
}

/** The full tool roster, one name per line — the entry point when no tool is named. */
export function listOrgTools(): string {
  return `org-tools:\n${(Object.keys(ORG_TOOL_INPUT_SCHEMAS) as OrgToolName[]).map((n) => `  ${n}`).join("\n")}`;
}
