/**
 * RFC 9457 problem+json (contracts.md "Errors"). One reply helper + the global error
 * handler: Zod validation failures → 400 with core-schema issue details; everything
 * else → 500 (or the error's own statusCode). Policy rejections (E6) will pass their
 * machine-readable `code` through `PolicyProblemError`.
 */
import type { FastifyReply, FastifyError, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { PolicyErrorCode, ProblemDetails } from "@foundry/core";

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly code?: PolicyErrorCode
  ) {
    super(detail ?? title);
  }
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): void {
  void reply
    .status(problem.status)
    .header("content-type", "application/problem+json")
    .send({ ...problem, type: problem.type || "about:blank" });
}

export function problemErrorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ZodError) {
    sendProblem(reply, {
      type: "about:blank",
      title: "Validation failed",
      status: 400,
      detail: "Request body does not match the schema.",
      instance: request.url,
      // RFC 9457 allows extension members; `issues` carries the core-schema details.
      ...( { issues: error.issues } as object),
    });
    return;
  }
  if (error instanceof ProblemError) {
    sendProblem(reply, {
      type: "about:blank",
      title: error.title,
      status: error.status,
      detail: error.detail,
      code: error.code,
      instance: request.url,
    });
    return;
  }
  sendProblem(reply, {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail: error.message,
    instance: request.url,
  });
}
