/**
 * E2.1 — Numbered, forward-only migrations (contracts.md "DB migrations"). Embedded as
 * TS string constants (not loose .sql files) so `tsc` ships them in `dist` without a
 * separate asset-copy step. Column shapes follow 05-data-and-persistence.md; JSON-typed
 * columns (`*_json`) store the core Zod shape verbatim (OPEN_ISSUES.md #1-#5 for the
 * value-object shapes).
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    up: `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_policy_json TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar_color TEXT,
  team_id TEXT REFERENCES teams(id),
  charter_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL,
  engine_config_json TEXT,
  memory_ref TEXT NOT NULL,
  default_workspace_ref_json TEXT,
  policy_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE agent_charters (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  edited_by_actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE workstreams (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  origin TEXT NOT NULL,
  task_id TEXT,
  workspace_ref_json TEXT,
  state TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  engine_session_ref TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_workstreams_agent ON workstreams(agent_id);
CREATE INDEX idx_workstreams_task ON workstreams(task_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id),
  seq INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  input_context_ref TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  engine_session_id TEXT,
  state TEXT NOT NULL,
  result_json TEXT,
  usage_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(workstream_id, seq)
);
CREATE INDEX idx_runs_workstream ON runs(workstream_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT REFERENCES tasks(id),
  root_task_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  delegator_actor_id TEXT NOT NULL,
  assignee_agent_id TEXT NOT NULL REFERENCES agents(id),
  routing_spec_json TEXT,
  spec_md TEXT NOT NULL,
  acceptance_criteria_md TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  state TEXT NOT NULL,
  deliverable_ref_json TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  rejection_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_tasks_root ON tasks(root_task_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_agent_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  anchor_type TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  round_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  from_actor_id TEXT NOT NULL,
  to_actor_id TEXT,
  to_team_id TEXT,
  type TEXT NOT NULL,
  body_md TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  disposition TEXT NOT NULL,
  disposition_ref TEXT,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_messages_thread ON messages(thread_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  requested_by_actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  state TEXT NOT NULL,
  decided_by_actor TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_sha256 ON artifacts(sha256);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  run_id TEXT,
  workstream_id TEXT,
  task_id TEXT
);
CREATE INDEX idx_events_workstream ON events(workstream_id);
CREATE INDEX idx_events_run ON events(run_id);
CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_type ON events(type);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  cron TEXT NOT NULL,
  prompt_md TEXT NOT NULL,
  enabled INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: "fts5-search",
    up: `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  id UNINDEXED,
  body_md
);

CREATE VIRTUAL TABLE workstreams_fts USING fts5(
  id UNINDEXED,
  title,
  goal_md
);

CREATE VIRTUAL TABLE runs_fts USING fts5(
  id UNINDEXED,
  result_json
);

INSERT INTO messages_fts (id, body_md)
SELECT id, body_md FROM messages;

INSERT INTO workstreams_fts (id, title, goal_md)
SELECT id, title, goal_md FROM workstreams;

INSERT INTO runs_fts (id, result_json)
SELECT id, result_json FROM runs WHERE result_json IS NOT NULL;
`,
  },
];
