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
import { createStore, type Store } from "@foundry/store";
import { createRuntime, type AdapterRegistry, type Runtime, type RunQueueLimits } from "@foundry/runtime";
import { composeContext } from "./context/compose.js";
import { problemErrorHandler } from "./problem.js";
import { createTokenRegistry, type TokenRegistry } from "./orgtools/tokens.js";
import { commitAgentMemory } from "./memory/git.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerWorkstreamRoutes } from "./routes/workstreams.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerFeedRoutes } from "./routes/feed.js";
import { registerOrgToolRoutes } from "./routes/orgtools.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerTaskRoutes } from "./routes/tasks.js";

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
  const runtime = createRuntime({
    store,
    adapters: config.adapters,
    dataDir: config.dataDir,
    limits: config.limits,
    defaultWallClockMs: config.defaultWallClockMs,
    defaultStallMs: config.defaultStallMs,
    composeContext: ({ run, workstream, agent }) =>
      composeContext({ store, dataDir: config.dataDir, run, workstream, agent }),
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
    afterRun: ({ run, agent }) => {
      // E11.1: git-version the agent's memory after every run that touched it.
      commitAgentMemory(config.dataDir, agent.memory_ref, `run ${run.id}`);
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
    onRunSettled: (runId, cb) => {
      const list = runSettled.get(runId) ?? [];
      list.push(cb);
      runSettled.set(runId, list);
    },
  };
  registerAgentRoutes(app, ctx);
  registerWorkstreamRoutes(app, ctx);
  registerQueryRoutes(app, ctx);
  registerFeedRoutes(app, ctx);
  registerOrgToolRoutes(app, ctx);
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
      return address;
    },
    async stop() {
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
  /** One-shot callback when a run's execute settles (E11.3 close-after-distillation). */
  onRunSettled(runId: string, cb: () => void): void;
}
