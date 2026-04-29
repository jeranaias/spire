import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { CalculationResult } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Mocks — order matters: vi.mock calls are hoisted to the top by vitest.
// ---------------------------------------------------------------------------

// Mock heavy shell components to avoid wouter/navigation setup in jsdom.
vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: () => null,
}));
vi.mock("@/components/title", () => ({
  Title: () => null,
}));

// Controlled API-client mock.  Both hooks are intercepted before any real
// network or TanStack Query internals run, so the test stays fast and
// deterministic.
const mockMutateAsync = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  Climate: {
    temperate: "temperate",
    arid: "arid",
    tropical: "tropical",
    arctic: "arctic",
  },
  OpTempo: {
    sustained: "sustained",
    intense: "intense",
  },
  useListUnits: () => ({
    data: [{ id: "unit-test-1", name: "Test Unit", personnel: 40 }],
  }),
  useCalculateRequirements: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Fixture — 40 PAX · 14 days · Temperate · Sustained
//   MRE:           3.0 × 1.0 × 1.0 × 40 = 120.00 /day   (total 1680.0)
//   Potable Water: 1.5 × 1.0 × 1.0 × 40 =  60.00 /day   (total  840.0)
// ---------------------------------------------------------------------------
const FIXTURE_RESULT: CalculationResult = {
  personnel: 40,
  days: 14,
  climate: "temperate",
  opTempo: "sustained",
  lines: [
    {
      item: {
        id: "item-mre",
        supplyClass: "I",
        name: "MRE",
        nsn: null,
        unit: "ea",
        baseDailyRate: 3,
        criticality: "critical",
        notes: null,
        isCustom: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      dailyConsumption: 120,
      totalRequired: 1680,
    },
    {
      item: {
        id: "item-water",
        supplyClass: "I",
        name: "Potable Water",
        nsn: null,
        unit: "gal",
        baseDailyRate: 1.5,
        criticality: "critical",
        notes: null,
        isCustom: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      dailyConsumption: 60,
      totalRequired: 840,
    },
  ],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    );
  };
}

// Lazy import so vi.mock hoisting completes before the module is evaluated.
async function renderCalculator() {
  const { default: StandaloneCalculator } = await import("../calculator");
  return render(<StandaloneCalculator />, { wrapper: makeWrapper() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Calculator bill rendering — /day display regression", () => {
  beforeEach(() => {
    mockMutateAsync.mockResolvedValue(FIXTURE_RESULT);
  });

  it('renders 120.00/day for MRE from dailyConsumption — not from dailyConsumption × personnel', async () => {
    await renderCalculator();

    // The Calculate button is enabled when a unit exists (mocked above).
    const calcButton = screen.getByRole("button", { name: /calculate/i });
    fireEvent.click(calcButton);

    // Wait for the async mutation to resolve and React state to update.
    await waitFor(() => {
      expect(screen.getByText(/requirements bill/i)).toBeInTheDocument();
    });

    // The bill must display dailyConsumption.toFixed(2) + "/day", which for
    // MRE is "120.00/day".  If someone reintroduces `* result.personnel`
    // (= 120 × 40 = 4800), this assertion will fail immediately.
    expect(screen.getByText("120.00/day")).toBeInTheDocument();

    // Negative regression guard: the inflated value from the prior bug must
    // never appear in the rendered output.
    expect(screen.queryByText("4800.00/day")).not.toBeInTheDocument();
  });

  it('renders 60.00/day for Potable Water from dailyConsumption directly', async () => {
    await renderCalculator();

    fireEvent.click(screen.getByRole("button", { name: /calculate/i }));

    await waitFor(() => {
      expect(screen.getByText(/requirements bill/i)).toBeInTheDocument();
    });

    expect(screen.getByText("60.00/day")).toBeInTheDocument();

    // Inflated value that would appear if someone multiplied by 40 again.
    expect(screen.queryByText("2400.00/day")).not.toBeInTheDocument();
  });

  it("bill shows both line items with correct names", async () => {
    await renderCalculator();

    fireEvent.click(screen.getByRole("button", { name: /calculate/i }));

    await waitFor(() => {
      expect(screen.getByText("MRE")).toBeInTheDocument();
    });

    expect(screen.getByText("Potable Water")).toBeInTheDocument();
  });
});
