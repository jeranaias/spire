import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import { closeTestPool } from "../../test/db-helpers";

// Health check has no error path worth covering — it's a constant 200 with a
// fixed body — so a single happy-path assertion is enough to detect the most
// common regression: the route file going missing or the response shape
// drifting out of sync with HealthCheckResponse.
describe("GET /api/healthz", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
