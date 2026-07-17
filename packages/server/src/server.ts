/**
 * E5.1 — control-plane server skeleton: startup orchestration (store open+migrate →
 * runtime reconcile → listen), config, problem+json errors, health endpoint. Route
 * modules register under `/api` and each owns exactly one file in `src/routes/` —
 * add routes there, not here.
 *
 * Adapters are injected (composition root = CLI daemon or a test), keeping this package
 * free of engine specifics per contracts.md.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore, type Store, computeAgentStatusFacts } from "@foundry/store";
import { createRuntime, type AdapterRegistry, type Runtime, type RunQueueLimits } from "@foundry/runtime";
import { composeContext } from "./context/compose.js";
import { problemErrorHandler } from "./problem.js";
import { createTokenRegistry, type TokenRegistry } from "./orgtools/tokens.js";
import { commitAgentMemory, commitAgentSkills } from "./memory/git.js";
import { sweepExpiredQuestions } from "./sweep/expireMessages.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerWorkstreamRoutes } from "./routes/workstreams.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerFeedRoutes } from "./routes/feed.js";
import { registerOrgToolRoutes } from "./routes/orgtools.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerClaudeSessionRoutes } from "./routes/claudeSessions.js";

export interface ServerConfig {
  dataDir: string;
  /** Defaults to `<dataDir>/foundry.db`; pass `:memory:` for tests. */
  dbPath?: string;
  host?: string;
  port?: number;
  adapters: AdapterRegistry;
  limits?: RunQueueLimits;
  defaultWallClockMs?: number;
  defaultStallMs?: number;
  /** E8.3: Interval to sweep expired questions (default 1 hour). */
  questionExpiryIntervalMs?: number;
  /** Root of Claude Code's own on-disk session transcripts, for the read-only
   * /api/claude-sessions browser. Defaults to `~/.claude/projects`; overridable so tests
   * can point at a fixture tree instead of the real machine's home directory. */
  claudeSessionsRoot?: string;
}

export interface FoundryServer {
  app: FastifyInstance;
  store: Store;
  runtime: Runtime;
  tokens: TokenRegistry;
  /** migrate (createStore) → reconcile (F3/F7) → listen. Returns the bound address. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

export function createServer(config: ServerConfig): FoundryServer {
  mkdirSync(config.dataDir, { recursive: true });
  const store = createStore({ dataDir: config.dataDir, dbPath: config.dbPath });
  const tokens = createTokenRegistry();
  const runSettled = new Map<string, Array<() => void>>();
  // Known once listen() returns; runs enqueued before that mint URL-less credentials
  // (fine — nothing can call the API before it listens either).
  let baseUrl = "";
  let questionExpiryInterval: ReturnType<typeof setInterval> | undefined;
  const runtime = createRuntime({
    store,
    adapters: config.adapters,
    dataDir: config.dataDir,
    limits: config.limits,
    defaultWallClockMs: config.defaultWallClockMs,
    defaultStallMs: config.defaultStallMs,
    composeContext: ({ run, workstream, agent, workspaceDir }) =>
      composeContext({ store, dataDir: config.dataDir, run, workstream, agent, workspaceDir }),
    // E6.1: per-run scoped credential — minted at run start, revoked when the run's
    // execute settles. The engine reaches org-tools via env (CLI shim) or mcpConfig
    // (E6.2/E9.2 wire the MCP side).
    mintRunCredential: ({ run, agent }) => {
      const token = tokens.mint({ runId: run.id, agentId: agent.id, actorId: agent.actor_id });
      return {
        cliEnv: {
          FOUNDRY_ORG_TOOLS_URL: `${baseUrl}/api/org-tools`,
          FOUNDRY_ORG_TOOLS_TOKEN: token,
        },
      };
    },
    revokeRunCredential: (run) => tokens.revokeRun(run.id),
    afterRun: ({ run, workstream, agent }) => {
      // E11.1: git-version the agent's memory after every run that touched it.
      commitAgentMemory(config.dataDir, agent.memory_ref, `run ${run.id}`);
      // E11.4: git-version the agent's skills directory after every run.
      commitAgentSkills(config.dataDir, agent.memory_ref, `run ${run.id}`);

      // E10.4 Rule 1: Crash loop detection — escalate when agent status becomes degraded.
      // `run` is the pre-execution object `execute()` resolved before the supervisor ran
      // (packages/runtime/src/facade.ts) — its `.state` is never updated in place as the
      // run progresses (all state changes go through the store, not this in-memory
      // reference), so checking `run.state` directly here would almost always see the
      // run's *original* state (e.g. "queued"), never "failed". Re-fetch fresh.
      const freshRun = store.runs.get(run.id);
      if (freshRun?.state === "failed") {
        const facts = computeAgentStatusFacts(store.db, agent.id);
        if (facts.recentConsecutiveFailures === 2) {
          const human = store.commands.getOrCreateHumanActor();
          const thread = store.commands.getOrCreateThread("workstream", agent.id);
          store.commands.sendMessage({
            thread_id: thread.id,
            from_actor_id: agent.actor_id,
            to_actor_id: human,
            type: "escalation",
            body_md: `Agent ${agent.name} has failed twice in a row and is now degraded. Consider investigating the root cause or temporarily reassigning work.`,
            refs: [],
            visibility: "surfaced",
          });
        }
      }

      // E10.4 Rule 2: Budget % threshold detection — escalate at 80% of budget limit.
      // Re-fetch fresh: the destructured `workstream` above is the pre-run snapshot
      // `execute()` resolved before this run started (packages/runtime/src/facade.ts),
      // not updated with whatever this run spent — checking it directly would always be
      // one run stale. Anchored to the *workstream* (not the agent) since budget is
      // per-workstream and an agent can have several; reusing the agent-level thread
      // would let one workstream's "budget" escalation suppress another's as a false
      // duplicate via the existing-open-escalation check below.
      const freshWorkstream = store.workstreams.get(workstream.id);
      if (freshWorkstream?.budget) {
        const { limit_usd, limit_tokens, spent_usd, spent_tokens } = freshWorkstream.budget;
        const thread = store.commands.getOrCreateThread("workstream", freshWorkstream.id);
        const openEscalations = store.messages
          .listByThread(thread.id)
          .filter((m) => m.type === "escalation" && m.disposition === "open");

        // Check USD budget threshold
        if (limit_usd !== null && spent_usd / limit_usd >= 0.8) {
          const existingEscalation = openEscalations.some((m) => m.body_md.includes("USD budget"));
          if (!existingEscalation) {
            const human = store.commands.getOrCreateHumanActor();
            const percentUsed = Math.round((spent_usd / limit_usd) * 100);
            store.commands.sendMessage({
              thread_id: thread.id,
              from_actor_id: agent.actor_id,
              to_actor_id: human,
              type: "escalation",
              body_md: `Workstream "${freshWorkstream.title}" (workstream:${freshWorkstream.id}) is at ${percentUsed}% of USD budget ($${spent_usd.toFixed(2)} of $${limit_usd.toFixed(2)}). Consider pausing or concluding work.`,
              refs: [],
              visibility: "surfaced",
            });
          }
        }

        // Check tokens budget threshold
        if (limit_tokens !== null && spent_tokens / limit_tokens >= 0.8) {
          const existingEscalation = openEscalations.some((m) => m.body_md.includes("token budget"));
          if (!existingEscalation) {
            const human = store.commands.getOrCreateHumanActor();
            const percentUsed = Math.round((spent_tokens / limit_tokens) * 100);
            store.commands.sendMessage({
              thread_id: thread.id,
              from_actor_id: agent.actor_id,
              to_actor_id: human,
              type: "escalation",
              body_md: `Workstream "${freshWorkstream.title}" (workstream:${freshWorkstream.id}) is at ${percentUsed}% of token budget (${spent_tokens} of ${limit_tokens} tokens). Consider pausing or concluding work.`,
              refs: [],
              visibility: "surfaced",
            });
          }
        }
      }

      // E11.3 etc.: one-shot per-run settle callbacks (e.g. close-after-distillation).
      const callbacks = runSettled.get(run.id);
      if (callbacks) {
        runSettled.delete(run.id);
        for (const cb of callbacks) {
          try {
            cb();
          } catch {
            // settle callbacks are best-effort by contract
          }
        }
      }
    },
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler(problemErrorHandler);

  app.get("/api/health", async () => ({ ok: true }));

  const ctx: RouteContext = {
    store,
    runtime,
    tokens,
    claudeSessionsRoot: config.claudeSessionsRoot ?? join(homedir(), ".claude", "projects"),
    onRunSettled: (runId, cb) => {
      const list = runSettled.get(runId) ?? [];
      list.push(cb);
      runSettled.set(runId, list);
    },
  };
  registerAgentRoutes(app, ctx);
  registerTeamRoutes(app, ctx);
  registerWorkstreamRoutes(app, ctx);
  registerQueryRoutes(app, ctx);
  registerFeedRoutes(app, ctx);
  registerOrgToolRoutes(app, ctx);
  registerClaudeSessionRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerTaskRoutes(app, ctx);

  return {
    app,
    store,
    runtime,
    tokens,
    async start() {
      const reconciled = await runtime.reconcileOnStartup();
      store.mutate({
        apply: () => undefined,
        events: [
          {
            actor_id: null,
            entity_type: "system",
            entity_id: "system",
            type: "system_started",
            payload: {},
          },
        ],
      });
      void reconciled;
      const address = await app.listen({ host: config.host ?? "127.0.0.1", port: config.port ?? 0 });
      baseUrl = address;

      // E8.3: Start periodic expiry sweep. Default 1 hour; .unref() so tests don't hang.
      const interval = config.questionExpiryIntervalMs ?? 60 * 60 * 1000;
      questionExpiryInterval = setInterval(() => {
        try {
          sweepExpiredQuestions({ store, now: new Date() });
        } catch (e) {
          // Sweep failures are logged but don't crash the server.
          console.error("Question expiry sweep failed:", e);
        }
      }, interval);
      questionExpiryInterval.unref();

      return address;
    },
    async stop() {
      if (questionExpiryInterval) {
        clearInterval(questionExpiryInterval);
      }
      await app.close();
      store.close();
    },
  };
}

/** Shared route-module context. */
export interface RouteContext {
  store: Store;
  runtime: Runtime;
  /** E6.1: per-run org-tools credentials (mint on run start, dead at run end). */
  tokens: TokenRegistry;
  /** Root of Claude Code's own on-disk session transcripts (see `claudeSessions/discover.ts`). */
  claudeSessionsRoot: string;
  /** One-shot callback when a run's execute settles (E11.3 close-after-distillation). */
  onRunSettled(runId: string, cb: () => void): void;
}
