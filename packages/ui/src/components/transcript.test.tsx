import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { parseTranscript, TranscriptBody, TranscriptTurn } from "./transcript.js";

describe("parseTranscript", () => {
  it("parses a slash-command invocation into a command segment", () => {
    const segs = parseTranscript(
      "<command-name>/compact</command-name> <command-message>compact</command-message> <command-args></command-args>"
    );
    expect(segs).toEqual([{ kind: "command", name: "/compact", args: "" }]);
  });

  it("keeps command args when present", () => {
    const segs = parseTranscript("<command-name>/model</command-name> <command-args>opus</command-args>");
    expect(segs).toEqual([{ kind: "command", name: "/model", args: "opus" }]);
  });

  it("parses local command output", () => {
    const segs = parseTranscript("<local-command-stdout>Compacted </local-command-stdout>");
    expect(segs).toEqual([{ kind: "stdout", text: "Compacted" }]);
  });

  it("parses a task-notification, pulling status/summary/result and usage", () => {
    const raw =
      "<task-notification> <task-id>a5</task-id> <status>completed</status> " +
      '<summary>Agent "Research Fields" finished</summary> ' +
      "<result>Report: **confirmed** facts here.</result> " +
      "<usage><subagent_tokens>50761</subagent_tokens><tool_uses>16</tool_uses><duration_ms>67592</duration_ms></usage> </task-notification>";
    const segs = parseTranscript(raw);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: "task",
      status: "completed",
      summary: 'Agent "Research Fields" finished',
      result: "Report: **confirmed** facts here.",
      tokens: 50761,
      toolUses: 16,
      durationMs: 67592,
    });
  });

  it("interleaves plain text around a block, dropping empty gaps", () => {
    const segs = parseTranscript("Before.\n<local-command-stdout>ok</local-command-stdout>\nAfter.");
    expect(segs).toEqual([
      { kind: "text", text: "Before." },
      { kind: "stdout", text: "ok" },
      { kind: "text", text: "After." },
    ]);
  });

  it("returns a single text segment for an ordinary message", () => {
    const segs = parseTranscript("Just a normal reply.");
    expect(segs).toEqual([{ kind: "text", text: "Just a normal reply." }]);
  });
});

describe("TranscriptBody", () => {
  it("renders a task notification's rendered markdown result and usage, not raw XML", () => {
    const raw =
      "<task-notification> <status>completed</status> <summary>Research Fields</summary> " +
      "<result>The **moat** is comms.</result> " +
      "<usage><subagent_tokens>1200</subagent_tokens><tool_uses>3</tool_uses><duration_ms>4200</duration_ms></usage> </task-notification>";
    render(<TranscriptBody text={raw} />);

    expect(screen.getByText("Research Fields")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("moat").tagName).toBe("STRONG"); // markdown rendered
    expect(screen.getByText(/1,200 tokens · 3 tool uses · 4s/)).toBeTruthy();
    expect(screen.queryByText(/task-notification/)).toBeNull(); // no raw tags
  });

  it("renders a slash command as a chip, not raw tags", () => {
    render(<TranscriptBody text="<command-name>/compact</command-name> <command-args></command-args>" />);
    expect(screen.getByText("/compact")).toBeTruthy();
    expect(screen.queryByText(/command-name/)).toBeNull();
  });
});

describe("TranscriptTurn attribution", () => {
  it("shows a task-notification as system even when the raw role is user", () => {
    render(<TranscriptTurn role="user" text="<task-notification><status>completed</status><summary>Did a thing</summary><result>done</result></task-notification>" />);
    expect(screen.getByText("system")).toBeTruthy();
    expect(screen.queryByText("user")).toBeNull();
  });

  it("shows command output as system", () => {
    render(<TranscriptTurn role="user" text="<local-command-stdout>Compacted</local-command-stdout>" />);
    expect(screen.getByText("system")).toBeTruthy();
    expect(screen.queryByText("user")).toBeNull();
  });

  it("keeps an ordinary text turn as its real role", () => {
    render(<TranscriptTurn role="user" text="Fix the bug please" />);
    expect(screen.getByText("user")).toBeTruthy();
  });

  it("keeps a slash command as the user — they typed it", () => {
    render(<TranscriptTurn role="user" text="<command-name>/compact</command-name>" />);
    expect(screen.getByText("user")).toBeTruthy();
    expect(screen.getByText("/compact")).toBeTruthy();
  });
});
