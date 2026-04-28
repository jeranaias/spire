// Task #174 — regression coverage for the Task #67 "Comms <Mode> —
// processing held" branch in ProcessingTab. The DDIL interceptor caches
// successful GETs and the in-memory job context is lost on reload, so this
// branch can't be reached end-to-end. Mounting with a mocked rejecting api
// is the cheapest reliable way to lock the comms-aware copy + Retry now
// behavior in place.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Mock the api module so the ProcessingTab fetches are deterministic.
vi.mock("../../api", () => {
  const jobStatus = vi.fn();
  const reviewQueue = vi.fn();
  return {
    api: {
      sentry: {
        jobStatus,
        reviewQueue,
      },
    },
  };
});

// Mock the Zustand store. ProcessingTab reads role, ddilMode, and
// ddilQueue.length via selectors; the mutable mockState lets each test
// dial in DDIL posture without re-initialising the store.
const mockState: { role: string; ddilMode: string; ddilQueue: unknown[] } = {
  role: "data_custodian",
  ddilMode: "DISCONNECTED",
  ddilQueue: [],
};
vi.mock("../../state/store", () => ({
  useSpireStore: <T,>(selector: (s: typeof mockState) => T) => selector(mockState),
}));

// Mock formatApiError to avoid pulling the retry/backoff module surface.
vi.mock("../../api-retry", () => ({
  formatApiError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

import { api } from "../../api";
import { ProcessingTab } from "./ProcessingTab";
import type { SentryContext } from "../SentryView";

const mockedJobStatus = api.sentry.jobStatus as ReturnType<typeof vi.fn>;
const mockedReviewQueue = api.sentry.reviewQueue as ReturnType<typeof vi.fn>;

function makeCtx(): SentryContext {
  return {
    batchId: "BATCH-TEST",
    jobId: "JOB-TEST",
    setBatch: vi.fn(),
    setJob: vi.fn(),
  };
}

function renderTab() {
  return render(
    <MemoryRouter>
      <ProcessingTab ctx={makeCtx()} />
    </MemoryRouter>,
  );
}

describe("ProcessingTab — DDIL held-error branch", () => {
  beforeEach(() => {
    mockedJobStatus.mockReset();
    mockedReviewQueue.mockReset();
    mockState.role = "data_custodian";
    mockState.ddilMode = "DISCONNECTED";
    mockState.ddilQueue = [];
  });

  it("renders the comms-aware 'processing held' block when fetches fail under DISCONNECTED", async () => {
    mockedJobStatus.mockRejectedValue(new Error("network down"));
    mockedReviewQueue.mockRejectedValue(new Error("network down"));

    renderTab();

    // The Task #67 held-error copy. If someone reverts to the generic
    // "pipeline did not respond" message, this fails.
    expect(
      await screen.findByText(/comms disconnected — processing held/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/comms link is down\. processing is held/i),
    ).toBeInTheDocument();

    // The held branch uses "Retry now" and must NOT bounce the user back
    // to Upload (which would also fail and lose batch context).
    expect(
      screen.getByRole("button", { name: /retry now/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /back to upload/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/pipeline did not respond/i),
    ).not.toBeInTheDocument();
  });

  it("uses LIMITED / INTERMITTENT copy when those DDIL modes are active", async () => {
    mockedJobStatus.mockRejectedValue(new Error("timeout"));
    mockedReviewQueue.mockRejectedValue(new Error("timeout"));
    mockState.ddilMode = "LIMITED";

    const { unmount } = renderTab();
    expect(
      await screen.findByText(/comms limited — processing held/i),
    ).toBeInTheDocument();
    unmount();

    mockState.ddilMode = "INTERMITTENT";
    renderTab();
    expect(
      await screen.findByText(/comms intermittent — processing held/i),
    ).toBeInTheDocument();
  });

  it("surfaces queued-write count when the DDIL queue is non-empty", async () => {
    mockedJobStatus.mockRejectedValue(new Error("network down"));
    mockedReviewQueue.mockRejectedValue(new Error("network down"));
    mockState.ddilQueue = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];

    renderTab();

    expect(
      await screen.findByText(/3 writes queued for replay when comms restore/i),
    ).toBeInTheDocument();
  });

  it("Retry now re-invokes the fetch", async () => {
    mockedJobStatus.mockRejectedValueOnce(new Error("network down"));
    mockedReviewQueue.mockRejectedValueOnce(new Error("network down"));

    renderTab();

    expect(
      await screen.findByRole("button", { name: /retry now/i }),
    ).toBeInTheDocument();
    expect(mockedJobStatus).toHaveBeenCalledTimes(1);
    const initialReviewCalls = mockedReviewQueue.mock.calls.length;

    // Keep the api rejecting so we stay in the held-error path and can
    // assert on the re-fetch alone (no need to stub a full payload).
    mockedJobStatus.mockRejectedValue(new Error("still down"));
    mockedReviewQueue.mockRejectedValue(new Error("still down"));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry now/i }));

    await waitFor(() => {
      expect(mockedJobStatus).toHaveBeenCalledTimes(2);
    });
    expect(mockedJobStatus).toHaveBeenLastCalledWith("JOB-TEST", "data_custodian");
    expect(mockedReviewQueue.mock.calls.length).toBe(initialReviewCalls);
    expect(
      screen.getByText(/comms disconnected — processing held/i),
    ).toBeInTheDocument();
  });

});
