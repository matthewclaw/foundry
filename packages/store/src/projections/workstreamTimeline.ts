/**
 * E2.5 / E2.6 — workstreamTimeline(): runs in a workstream, each with its non-output-delta
 * events plus a reconstructed transcript. The transcript comes from the live
 * `run_output_delta` events if they're still in the table, or falls back to the
 * compacted transcript file on disk (E2.6 AC: "after compaction the timeline still
 * renders from the transcript file").
 */
import { existsSync, readFileSync } from "node:fs";
import type { AgentId, Event, Run, WorkstreamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToRun, type RunRow } from "../mutations/runs.js";
import { rowToWorkstream, type WorkstreamRow } from "../mutations/workstreams.js";
import { rowToAgent, type AgentRow } from "../mutations/agents.js";
import { rowToEvent, type EventRow } from "../row-mapping.js";
import { transcriptPath } from "../events/feed.js";

export interface TimelineRunEntry {
  run: Run;
  /** Non-output-delta events for this run still in the table (tool calls, state changes, usage). */
  events: Event[];
  transcriptText: string | null;
  transcriptSource: "live" | "file" | "none";
}

/** Just enough about the workstream (and the agent it belongs to) for the timeline view
 * to render a real header/breadcrumb instead of a bare id. */
export interface TimelineHeader {
  id: WorkstreamId;
  title: string;
  goal_md: string;
  state: string;
  agent: { id: AgentId; name: string } | null;
}

export interface Timeline {
  workstreamId: WorkstreamId;
  workstream: TimelineHeader | null;
  runs: TimelineRunEntry[];
}

export interface TimelinePage {
  limit?: number;
  /** Only runs with seq < before (for paging backwards from the latest). */
  before?: number;
}

export function workstreamTimeline(db: Db, dataDir: string, workstreamId: WorkstreamId, page?: TimelinePage): Timeline {
  const clauses = ["workstream_id = @workstream_id"];
  const params: Record<string, unknown> = { workstream_id: workstreamId };
  if (page?.before !== undefined) {
    clauses.push("seq < @before");
    params.before = page.before;
  }
  const limit = page?.limit ?? 50;

  const wsRow = db.prepare(`SELECT * FROM workstreams WHERE id = ?`).get(workstreamId) as WorkstreamRow | undefined;
  let header: TimelineHeader | null = null;
  if (wsRow) {
    const ws = rowToWorkstream(wsRow);
    const agentRow = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(ws.agent_id) as AgentRow | undefined;
    const agent = agentRow ? rowToAgent(agentRow) : null;
    header = {
      id: ws.id,
      title: ws.title,
      goal_md: ws.goal_md,
      state: ws.state,
      agent: agent ? { id: agent.id, name: agent.name } : null,
    };
  }

  const runRows = db
    .prepare(`SELECT * FROM runs WHERE workstream_id = ? ORDER BY seq DESC LIMIT ?`)
    .all(workstreamId, limit) as RunRow[];
  const runs = runRows.map(rowToRun).reverse();

  const entries: TimelineRunEntry[] = runs.map((run) => {
    const eventRows = db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND type != 'run_output_delta' ORDER BY seq`)
      .all(run.id) as EventRow[];
    const events = eventRows.map(rowToEvent);

    const deltaRows = db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND type = 'run_output_delta' ORDER BY seq`)
      .all(run.id) as EventRow[];

    let transcriptText: string | null;
    let transcriptSource: TimelineRunEntry["transcriptSource"];
    if (deltaRows.length > 0) {
      transcriptText = deltaRows.map((r) => (JSON.parse(r.payload_json) as { text: string }).text).join("");
      transcriptSource = "live";
    } else {
      const path = transcriptPath(dataDir, run.id);
      if (existsSync(path)) {
        transcriptText = readFileSync(path, "utf-8");
        transcriptSource = "file";
      } else {
        transcriptText = null;
        transcriptSource = "none";
      }
    }

    return { run, events, transcriptText, transcriptSource };
  });

  return { workstreamId, workstream: header, runs: entries };
}
