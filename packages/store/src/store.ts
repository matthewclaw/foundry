/**
 * Assembles the exact `Store` interface from contracts.md: `mutate()` as the sole write
 * path, per-entity queries, the event feed, and the projections — plus an additive
 * `commands` namespace (not in the literal contracts.md snippet, but doesn't shrink it)
 * that gives callers (runtime/server) the transition-enforcing mutation helpers without
 * ever handing out a raw, writable `db` handle outside of `mutate()`'s `apply(tx)`.
 */
import { join } from "node:path";
import type { AgentId, Approval, Artifact, ArtifactId, Run, Task, Team, Thread, ThreadAnchorType, Workstream } from "@foundry/core";
import { openDb, type Db } from "./db/connection.js";
import { createEventBus } from "./events/bus.js";
import { createMutate } from "./mutate.js";
import type { Mutate } from "./types.js";

import { createAgentQueries, type AgentQueries } from "./queries/agents.js";
import { createTeamQueries, type TeamQueries } from "./queries/teams.js";
import { createWorkstreamQueries, type WorkstreamQueries } from "./queries/workstreams.js";
import { createRunQueries, type RunQueries } from "./queries/runs.js";
import { createTaskQueries, type TaskQueries } from "./queries/tasks.js";
import { createMessageQueries, type MessageQueries } from "./queries/messages.js";
import { createApprovalQueries, type ApprovalQueries } from "./queries/approvals.js";

import { createEventFeed, type EventFeed } from "./events/feed.js";
import { createProjections, type Projections } from "./projections/index.js";

import {
  createAgent,
  transitionAgentState,
  updateAgentCharter,
  rebindAgentEngine,
  getOrCreateHumanActor,
  type CreateAgentInput,
  type TransitionAgentStateArgs,
} from "./mutations/agents.js";
import { createTeam, type CreateTeamInput } from "./mutations/teams.js";
import {
  createWorkstream,
  transitionWorkstreamState,
  type CreateWorkstreamInput,
  type TransitionWorkstreamStateArgs,
} from "./mutations/workstreams.js";
import {
  createRun,
  transitionRunState,
  emitRunDetailEvent,
  type CreateRunInput,
  type TransitionRunStateArgs,
} from "./mutations/runs.js";
import {
  createTask,
  transitionTaskState,
  type CreateTaskInput,
  type TransitionTaskStateArgs,
} from "./mutations/tasks.js";
import {
  getOrCreateThread,
  sendMessage,
  resolveMessageDisposition,
  type SendMessageInput,
  type ResolveMessageDispositionArgs,
} from "./mutations/messages.js";
import {
  requestApproval,
  decideApproval,
  type RequestApprovalInput,
  type DecideApprovalArgs,
} from "./mutations/approvals.js";
import { putArtifact, readArtifact, type PutArtifactInput } from "./artifacts/store.js";
import { backupStore, type BackupResult } from "./backup.js";
import type { NewEvent } from "./types.js";

export interface StoreConfig {
  /** Root data directory (05: `.foundry/`) — holds runs/, artifacts/. */
  dataDir: string;
  /** Defaults to `<dataDir>/foundry.db`; pass `:memory:` for tests. */
  dbPath?: string;
}

export interface StoreCommands {
  createAgent(input: CreateAgentInput): ReturnType<typeof createAgent>;
  transitionAgentState(args: TransitionAgentStateArgs): void;
  updateAgentCharter(args: Parameters<typeof updateAgentCharter>[2]): { version: number };
  rebindAgentEngine(args: Parameters<typeof rebindAgentEngine>[2]): void;
  getOrCreateHumanActor(displayName?: string): ReturnType<typeof getOrCreateHumanActor>;
  createTeam(input: CreateTeamInput): Team;
  createWorkstream(input: CreateWorkstreamInput): Workstream;
  transitionWorkstreamState(args: TransitionWorkstreamStateArgs): void;
  createRun(input: CreateRunInput): Run;
  transitionRunState(args: TransitionRunStateArgs): void;
  emitRunDetailEvent(
    event: Pick<NewEvent, "entity_id" | "type" | "payload" | "run_id" | "workstream_id" | "actor_id">
  ): void;
  createTask(input: CreateTaskInput): Task;
  transitionTaskState(args: TransitionTaskStateArgs): void;
  getOrCreateThread(anchorType: ThreadAnchorType, anchorId: string): Thread;
  sendMessage(input: SendMessageInput): ReturnType<typeof sendMessage>;
  resolveMessageDisposition(args: ResolveMessageDispositionArgs): void;
  requestApproval(input: RequestApprovalInput): Approval;
  decideApproval(args: DecideApprovalArgs): void;
  putArtifact(input: PutArtifactInput): Artifact;
}

export interface Store {
  mutate: Mutate;
  agents: AgentQueries;
  teams: TeamQueries;
  workstreams: WorkstreamQueries;
  runs: RunQueries;
  tasks: TaskQueries;
  messages: MessageQueries;
  approvals: ApprovalQueries;
  events: EventFeed;
  projections: Projections;
  commands: StoreCommands;
  readArtifact(id: ArtifactId): { artifact: Artifact; content: Buffer };
  backup(destDir: string): Promise<BackupResult>;
  close(): void;
}

export function createStore(config: StoreConfig): Store {
  const dbPath = config.dbPath ?? join(config.dataDir, "foundry.db");
  const db: Db = openDb(dbPath);
  const bus = createEventBus();
  const mutate = createMutate(db, bus);

  return {
    mutate,
    agents: createAgentQueries(db),
    teams: createTeamQueries(db),
    workstreams: createWorkstreamQueries(db),
    runs: createRunQueries(db),
    tasks: createTaskQueries(db),
    messages: createMessageQueries(db),
    approvals: createApprovalQueries(db),
    events: createEventFeed(db, bus, mutate, config.dataDir),
    projections: createProjections(db, config.dataDir),
    commands: {
      createAgent: (input) => createAgent(mutate, input),
      transitionAgentState: (args) => transitionAgentState(db, mutate, args),
      updateAgentCharter: (args) => updateAgentCharter(db, mutate, args),
      rebindAgentEngine: (args) => rebindAgentEngine(db, mutate, args),
      getOrCreateHumanActor: (displayName) => getOrCreateHumanActor(db, mutate, displayName),
      createTeam: (input) => createTeam(mutate, input),
      createWorkstream: (input) => createWorkstream(mutate, input),
      transitionWorkstreamState: (args) => transitionWorkstreamState(db, mutate, args),
      createRun: (input) => createRun(mutate, input),
      transitionRunState: (args) => transitionRunState(db, mutate, args),
      emitRunDetailEvent: (event) => emitRunDetailEvent(mutate, event),
      createTask: (input) => createTask(db, mutate, input),
      transitionTaskState: (args) => transitionTaskState(db, mutate, args),
      getOrCreateThread: (anchorType, anchorId) => getOrCreateThread(db, mutate, anchorType, anchorId),
      sendMessage: (input) => sendMessage(mutate, input),
      resolveMessageDisposition: (args) => resolveMessageDisposition(db, mutate, args),
      requestApproval: (input) => requestApproval(mutate, input),
      decideApproval: (args) => decideApproval(db, mutate, args),
      putArtifact: (input) => putArtifact(mutate, config.dataDir, input),
    },
    readArtifact: (id) => readArtifact(db, config.dataDir, id),
    backup: (destDir) => backupStore({ db, mutate, dataDir: config.dataDir, destDir }),
    close: () => db.close(),
  };
}
