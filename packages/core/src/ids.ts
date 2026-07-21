/**
 * E1.5 — ULID ids and typed refs.
 *
 * Every entity id is a ULID (sortable, no coordination — see 05-data-and-persistence.md).
 * Ids are branded per entity kind so e.g. an ActorId can't be passed where a TaskId is
 * expected, even though both are plain strings at runtime.
 */
import { monotonicFactory } from "ulid";
import { z } from "zod";

const generateUlid = monotonicFactory();

export type Ulid = string;

/** Crockford base32, 26 chars, time component first (so lexicographic order == chronological order). */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isValidUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** Monotonic within a process: successive calls sort correctly even within the same millisecond. */
export function newUlid(): Ulid {
  return generateUlid();
}

export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };

function brandedUlidSchema<Tag extends string>(): z.ZodType<Brand<Ulid, Tag>> {
  return z
    .string()
    .refine(isValidUlid, { message: "Invalid ULID" }) as unknown as z.ZodType<Brand<Ulid, Tag>>;
}

function idKit<Tag extends string>() {
  const schema = brandedUlidSchema<Tag>();
  return {
    schema,
    newId: (): Brand<Ulid, Tag> => newUlid() as Brand<Ulid, Tag>,
  };
}

export const ActorIdSchema = idKit<"ActorId">().schema;
export type ActorId = z.infer<typeof ActorIdSchema>;
export const newActorId = idKit<"ActorId">().newId;

export const AgentIdSchema = idKit<"AgentId">().schema;
export type AgentId = z.infer<typeof AgentIdSchema>;
export const newAgentId = idKit<"AgentId">().newId;

export const TeamIdSchema = idKit<"TeamId">().schema;
export type TeamId = z.infer<typeof TeamIdSchema>;
export const newTeamId = idKit<"TeamId">().newId;

export const WorkstreamIdSchema = idKit<"WorkstreamId">().schema;
export type WorkstreamId = z.infer<typeof WorkstreamIdSchema>;
export const newWorkstreamId = idKit<"WorkstreamId">().newId;

export const RunIdSchema = idKit<"RunId">().schema;
export type RunId = z.infer<typeof RunIdSchema>;
export const newRunId = idKit<"RunId">().newId;

export const TaskIdSchema = idKit<"TaskId">().schema;
export type TaskId = z.infer<typeof TaskIdSchema>;
export const newTaskId = idKit<"TaskId">().newId;

export const MessageIdSchema = idKit<"MessageId">().schema;
export type MessageId = z.infer<typeof MessageIdSchema>;
export const newMessageId = idKit<"MessageId">().newId;

export const ThreadIdSchema = idKit<"ThreadId">().schema;
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export const newThreadId = idKit<"ThreadId">().newId;

export const ApprovalIdSchema = idKit<"ApprovalId">().schema;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export const newApprovalId = idKit<"ApprovalId">().newId;

export const ArtifactIdSchema = idKit<"ArtifactId">().schema;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export const newArtifactId = idKit<"ArtifactId">().newId;

export const ScheduleIdSchema = idKit<"ScheduleId">().schema;
export type ScheduleId = z.infer<typeof ScheduleIdSchema>;
export const newScheduleId = idKit<"ScheduleId">().newId;

/**
 * events.seq is a monotonic SQLite INTEGER PRIMARY KEY, not a ULID (05-data-and-persistence.md) —
 * event refs below carry that seq as a decimal string instead of a ULID.
 */
export type EventSeq = number;

// --- Typed refs: `${kind}:${id}`, e.g. "artifact:01J...", "event:482" ---

export const REF_KINDS = [
  "actor",
  "agent",
  "team",
  "workstream",
  "run",
  "task",
  "message",
  "thread",
  "approval",
  "artifact",
  "schedule",
  "event",
] as const;

export type RefKind = (typeof REF_KINDS)[number];

export type Ref = `${RefKind}:${string}`;

export function formatRef(kind: RefKind, id: string): Ref {
  return `${kind}:${id}`;
}

export function parseRef(ref: string): { kind: RefKind; id: string } {
  const idx = ref.indexOf(":");
  if (idx <= 0) {
    throw new Error(`Malformed ref (expected "<kind>:<id>"): ${ref}`);
  }
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (!(REF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown ref kind "${kind}" in ref: ${ref}`);
  }
  if (id.length === 0) {
    throw new Error(`Malformed ref (empty id): ${ref}`);
  }
  if (kind === "event") {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Malformed event ref (expected decimal seq): ${ref}`);
    }
  } else if (!isValidUlid(id)) {
    throw new Error(`Malformed ${kind} ref (expected ULID id): ${ref}`);
  }
  return { kind: kind as RefKind, id };
}

export function isValidRef(value: string): value is Ref {
  try {
    parseRef(value);
    return true;
  } catch {
    return false;
  }
}

export const RefSchema = z
  .string()
  .refine(isValidRef, { message: "Invalid ref" })
  .describe(`"<kind>:<id>" ref (kind ∈ ${REF_KINDS.join("|")}; id is a ULID, or a decimal seq for event) — e.g. "artifact:01H…"; use [] if none`) as unknown as z.ZodType<Ref>;
