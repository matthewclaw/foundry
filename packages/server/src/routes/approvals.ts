/**
 * E6.4 — approvals: POST /api/approvals/:id/{grant,deny} (contracts.md API contract).
 * Grant re-triggers the requesting workstream with `approval_granted` so the decision
 * reaches the agent in its next composed context; deny records the decision (the
 * workstream stays waiting for the human's follow-up — surfacing is E10's inbox).
 */
import type { FastifyInstance } from "fastify";
import { DenyApprovalRequestSchema, GrantApprovalRequestSchema, type ApprovalId, type WorkstreamId } from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";

export function registerApprovalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/grant", async (request, reply) => {
    GrantApprovalRequestSchema.parse(request.body ?? {});
    const approval = decide(ctx, request.params.id, "granted");

    // Schedule the follow-up run so the grant reaches the agent (E6.4 AC: "grant ⇒ next
    // run scheduled with decision in context").
    const workstreamId = (approval.payload as { workstream_id?: WorkstreamId } | undefined)?.workstream_id;
    let runId: string | undefined;
    if (workstreamId && ctx.store.workstreams.get(workstreamId)) {
      try {
        runId = ctx.runtime.enqueue({ workstreamId, trigger: "approval_granted" }).id;
      } catch (err) {
        throw new ProblemError(409, "Approval granted but run not scheduled", err instanceof Error ? err.message : String(err));
      }
    }
    return reply.status(200).send({ approval: ctx.store.approvals.get(approval.id), run_id: runId ?? null });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/deny", async (request, reply) => {
    const body = DenyApprovalRequestSchema.parse(request.body ?? {});
    const approval = decide(ctx, request.params.id, "denied", body.reason);
    return reply.status(200).send({ approval: ctx.store.approvals.get(approval.id) });
  });
}

function decide(ctx: RouteContext, id: string, decision: "granted" | "denied", reason?: string) {
  const approval = ctx.store.approvals.get(id as ApprovalId);
  if (!approval) throw new ProblemError(404, "Approval not found", `approval ${id} does not exist`);
  try {
    ctx.store.commands.decideApproval({
      id,
      decision,
      decided_by_actor: ctx.store.commands.getOrCreateHumanActor(),
      reason,
    });
  } catch (err) {
    throw new ProblemError(409, "Approval already decided", err instanceof Error ? err.message : String(err), "invalid_transition");
  }
  return approval;
}
