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
import { registerAgentRoutes } from "./routes/agents.js";
import { registerWorkstreamRoutes } from "./routes/workstreams.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerFeedRoutes } from "./routes/feed.js";
import { registerAdminRoutes } from "./routes/admin.js";

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
  /** migrate (createStore) → reconcile (F3/F7) → listen. Returns the bound address. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

export function createServer(config: ServerConfig): FoundryServer {
  mkdirSync(config.dataDir, { recursive: true });
  const store = createStore({ dataDir: config.dataDir, dbPath: config.dbPath });
  const runtime = createRuntime({
    store,
    adapters: config.adapters,
    dataDir: config.dataDir,
    limits: config.limits,
    defaultWallClockMs: config.defaultWallClockMs,
    defaultStallMs: config.defaultStallMs,
    composeContext: ({ run, workstream, agent }) =>
      composeContext({ store, dataDir: config.dataDir, run, workstream, agent }),
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler(problemErrorHandler);

  app.get("/api/health", async () => ({ ok: true }));

  const ctx = { store, runtime };
  registerAgentRoutes(app, ctx);
  registerWorkstreamRoutes(app, ctx);
  registerQueryRoutes(app, ctx);
  registerFeedRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  return {
    app,
    store,
    runtime,
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
      return app.listen({ host: config.host ?? "127.0.0.1", port: config.port ?? 0 });
    },
    async stop() {
      await app.close();
      store.close();
    },
  };
}

/** Shared route-module context: every module gets the same two capabilities. */
export interface RouteContext {
  store: Store;
  runtime: Runtime;
}
