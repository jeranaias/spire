import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";

function isZodError(err: unknown): err is { issues: Array<{ path: (string | number)[]; message: string; code: string }> } {
  return typeof err === "object" && err !== null
    && (err as { name?: string }).name === "ZodError"
    && Array.isArray((err as { issues?: unknown }).issues);
}

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && "code" in err;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (isZodError(err)) {
    res.status(400).json({
      error: "ValidationError",
      message: "Request payload failed validation",
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
    return;
  }

  if (isPgError(err)) {
    if (err.code === "23503") {
      res.status(409).json({
        error: "ForeignKeyViolation",
        message: "Referenced resource does not exist",
        detail: err.detail,
      });
      return;
    }
    if (err.code === "23505") {
      res.status(409).json({
        error: "UniqueViolation",
        message: "Resource already exists",
        detail: err.detail,
      });
      return;
    }
    if (err.code === "23502" || err.code === "22P02") {
      res.status(400).json({
        error: "InvalidInput",
        message: "Invalid input value",
        detail: err.detail,
      });
      return;
    }
  }

  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { status?: number; statusCode?: number })?.statusCode
    ?? 500;

  if (status >= 500) {
    logger.error({ err }, "Unhandled error in request");
  }

  res.status(status).json({
    error: status >= 500 ? "InternalServerError" : "Error",
    message: (err as { message?: string })?.message ?? "Unexpected error",
  });
};
