/**
 * E10.3 tests: cost view renders org-wide spend, limits, and breakdown table.
 * Uncapped limits show "uncapped", empty breakdown shows empty state message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CostReport } from "../api/types.js";
import CostView from "./CostView.js";

vi.mock("../api/client.js", () => ({
  apiClient: {
    getCost: vi.fn(),
  },
}));
import { apiClient } from "../api/client.js";

const fixture: CostReport = {
  scope: { level: "org" },
  spent_usd: 1234.56,
  spent_tokens: 5000000,
  limit_usd: 5000,
  limit_tokens: 10000000,
  breakdown: [
    { label: "Claude Haiku (inference)", spent_usd: 100.5, spent_tokens: 3000000 },
    { label: "Claude Opus (inference)", spent_usd: 1000.0, spent_tokens: 1500000 },
    { label: "Claude Sonnet (cache reads)", spent_usd: 134.06, spent_tokens: 500000 },
  ],
};

function renderCostView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cost"]}>
        <Routes>
          <Route path="/cost" element={<CostView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CostView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getCost).mockResolvedValue(fixture);
  });

  it("renders heading and org-wide scope label", async () => {
    renderCostView();

    await screen.findByText("Cost");
    expect(screen.getByText(/Org-wide spend/)).toBeTruthy();
  });

  it("renders stat blocks with USD and token values", async () => {
    renderCostView();

    await screen.findByText("Cost");

    // Check that the values from the fixture appear in the page
    const pageText = document.documentElement.textContent || "";
    expect(pageText).toContain("USD Spent");
    expect(pageText).toContain("Tokens Spent");
    expect(pageText).toContain("1234.56");
    expect(pageText).toContain("5000");
  });

  it("renders breakdown table with all entries", async () => {
    renderCostView();

    await screen.findByText("Breakdown");
    expect(screen.getByText("Claude Haiku (inference)")).toBeTruthy();
    expect(screen.getByText("Claude Opus (inference)")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet (cache reads)")).toBeTruthy();

    // Check for dollar amounts
    const usdAmounts = screen.getAllByText(/^\$/);
    expect(usdAmounts.length).toBeGreaterThan(0);

    // Check that breakdown text contains the values (may appear multiple times)
    const pageText = document.body.textContent || "";
    expect(pageText).toContain("3,000,000");
    expect(pageText).toContain("1,500,000");
    expect(pageText).toContain("500,000");
  });

  it("shows empty state when breakdown is empty", async () => {
    const emptyFixture: CostReport = {
      ...fixture,
      breakdown: [],
    };
    vi.mocked(apiClient.getCost).mockResolvedValue(emptyFixture);

    renderCostView();

    await screen.findByText("Cost");
    expect(screen.getByText("No spend recorded yet.")).toBeTruthy();
  });

  it("shows 'uncapped' when limits are null", async () => {
    const uncappedFixture: CostReport = {
      ...fixture,
      limit_usd: null,
      limit_tokens: null,
    };
    vi.mocked(apiClient.getCost).mockResolvedValue(uncappedFixture);

    renderCostView();

    await screen.findByText("Cost");
    // When limits are null, "No limit set" is shown (appears in both stat blocks)
    const noLimitElements = screen.getAllByText("No limit set");
    expect(noLimitElements.length).toBe(2);
    // Check that "uncapped" text appears in the stat block spans
    const allText = document.body.textContent;
    expect(allText).toContain("uncapped");
  });
});
