/**
 * E10.1 tests: inbox sorts by severity (approvals first), then by age (oldest first).
 * Grant/Deny buttons call the right mutations and refetch. Message items have no actions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxItem } from "../api/types.js";
import Inbox, { sortInboxItems } from "./Inbox.js";

vi.mock("../api/client.js", () => ({
  apiClient: {
    getInbox: vi.fn(),
    grantApproval: vi.fn(),
    denyApproval: vi.fn(),
  },
}));
import { apiClient } from "../api/client.js";

// Valid ULID format for testing (26 chars, Crockford base32)
const fixtureItems: InboxItem[] = [
  {
    kind: "message_surfaced",
    ref: "message:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    created_at: "2026-07-01T10:00:00Z",
    summary: "Old message",
  },
  {
    kind: "approval_pending",
    ref: "approval:01BPMR85Z94C6L7QZ5D95NPZZZ",
    created_at: "2026-07-10T15:00:00Z",
    summary: "New approval needed",
  },
  {
    kind: "approval_pending",
    ref: "approval:01ARZ3NDEKTSV4RRFFQ69G5FAW",
    created_at: "2026-07-05T12:00:00Z",
    summary: "Old approval needed",
  },
  {
    kind: "message_surfaced",
    ref: "message:01BPMR85Z94C6L7QZ5D95NQAAA",
    created_at: "2026-07-10T16:00:00Z",
    summary: "New message",
  },
];

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <Routes>
          <Route path="/inbox" element={<Inbox />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getInbox).mockResolvedValue(fixtureItems);
  });

  it("sorts by severity (approvals first) then by age (oldest first)", async () => {
    renderInbox();

    // Wait for all items to render
    await screen.findByText("Old approval needed");
    await screen.findByText("New approval needed");
    await screen.findByText("Old message");
    await screen.findByText("New message");

    // Get all rendered items in order
    const allTexts = screen.queryAllByText(/Old approval needed|New approval needed|Old message|New message/);
    const textOrder = allTexts.map((el) => el.textContent);

    // Expected order: Old approval, New approval, Old message, New message
    expect(textOrder[0]).toContain("Old approval needed");
    expect(textOrder[1]).toContain("New approval needed");
    expect(textOrder[2]).toContain("Old message");
    expect(textOrder[3]).toContain("New message");
  });

  it("renders Grant and Deny buttons for approval items only", async () => {
    renderInbox();

    await screen.findByText("New approval needed");

    // approval items should have both buttons (2 approval items = 2 Grant + 2 Deny)
    const grantButtons = screen.getAllByText("Grant");
    const denyButtons = screen.getAllByText("Deny");
    expect(grantButtons.length).toBe(2);
    expect(denyButtons.length).toBe(2);

    // message items should have no buttons
    expect(screen.queryByText("Old message")).toBeTruthy();
    expect(screen.queryByText("New message")).toBeTruthy();
  });

  it("clicking Grant calls grantApproval with the parsed id and refetches inbox", async () => {
    vi.mocked(apiClient.grantApproval).mockResolvedValue({});
    renderInbox();

    await screen.findByText("Old approval needed");

    const grantButtons = screen.getAllByText("Grant");
    // First grant button is for the first approval in sorted order (old approval)
    if (grantButtons[0]) {
      fireEvent.click(grantButtons[0]);
    }

    await waitFor(() => {
      expect(apiClient.grantApproval).toHaveBeenCalledWith("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    });

    // Refetch inbox
    await waitFor(() => {
      expect(vi.mocked(apiClient.getInbox).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("clicking Deny calls denyApproval with parsed id and reason, refetches inbox", async () => {
    vi.mocked(apiClient.denyApproval).mockResolvedValue({});
    global.window.prompt = vi.fn(() => "Budget exceeded");

    renderInbox();

    await screen.findByText("New approval needed");

    const denyButtons = screen.getAllByText("Deny");
    // First deny button is on the first approval in sorted order (old approval)
    if (denyButtons[0]) {
      fireEvent.click(denyButtons[0]);
    }

    await waitFor(() => {
      expect(apiClient.denyApproval).toHaveBeenCalledWith("01ARZ3NDEKTSV4RRFFQ69G5FAW", "Budget exceeded");
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.getInbox).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("sortInboxItems places approvals before messages, sorts each by age", () => {
    const sorted = sortInboxItems(fixtureItems);

    expect(sorted.length).toBe(4);
    expect(sorted[0]?.kind).toBe("approval_pending");
    expect(sorted[0]?.ref).toBe("approval:01ARZ3NDEKTSV4RRFFQ69G5FAW");

    expect(sorted[1]?.kind).toBe("approval_pending");
    expect(sorted[1]?.ref).toBe("approval:01BPMR85Z94C6L7QZ5D95NPZZZ");

    expect(sorted[2]?.kind).toBe("message_surfaced");
    expect(sorted[2]?.ref).toBe("message:01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(sorted[3]?.kind).toBe("message_surfaced");
    expect(sorted[3]?.ref).toBe("message:01BPMR85Z94C6L7QZ5D95NQAAA");
  });
});
