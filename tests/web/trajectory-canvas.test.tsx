import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "../../src/shared/contracts.js";
import { TrajectoryCanvas } from "../../src/web/components/trajectory-canvas.js";
import { projectTrajectory } from "../../src/web/components/trajectory-model.js";

const events: NormalizedEvent[] = [
  event(1, "user_message", { text: "Review the project", messageId: "m-1" }),
  event(2, "reasoning", { summary: "Inspecting files" }),
  event(3, "tool", { id: "call-1", name: "read_file", input: { path: "src/app.tsx" }, status: "started" }),
  event(4, "tool", { id: "call-1", status: "completed", result: "source" }),
  event(5, "usage", { input_tokens: 12, output_tokens: 5 }),
  event(6, "assistant_message", { text: "Review complete" }),
  event(7, "turn_status", { turnId: "turn-1", status: "completed" }),
  event(8, "user_message", { text: "Fix it", messageId: "m-2" }),
  event(9, "warning", { message: "Limited metadata" }),
];
const readStyles = () => readFileSync("src/web/styles.css", "utf8");

describe("trajectory projection", () => {
  it("groups records by turn and merges tool lifecycle updates", () => {
    const model = projectTrajectory(events);

    expect(model.turns).toHaveLength(2);
    expect(model.turns[0]?.records.map((record) => record.kind)).toEqual([
      "user", "reasoning", "tool", "assistant", "status",
    ]);
    expect(model.turns[0]?.records.find((record) => record.kind === "tool")).toMatchObject({
      title: "read_file",
      payload: expect.objectContaining({ status: "completed", result: "source" }),
    });
    expect(model.turns[1]?.records[0]?.title).toBe("USER");
  });

  it("reports only observed timing and leaves usage to the Turn footer", () => {
    const model = projectTrajectory(events);
    const tool = model.turns[0]?.records.find((record) => record.kind === "tool");

    expect(tool?.durationMs).toBe(1_000);
    expect(model.turns[0]).not.toHaveProperty("usage");
    expect(model.turns[0]?.records.find((record) => record.kind === "assistant")?.durationMs).toBeNull();
  });

  it("coalesces assistant stream fragments into one useful trajectory record", () => {
    const model = projectTrajectory([
      event(1, "user_message", { text: "你是什么模型" }),
      event(2, "assistant_message", { text: "我是", streamId: "message-1", delta: true }),
      event(3, "assistant_message", { text: " Codex", streamId: "message-1", delta: true }),
      event(4, "assistant_message", { text: "我是 Codex。", streamId: "message-1", final: true }),
    ]);

    expect(model.turns[0]?.records).toHaveLength(2);
    expect(model.turns[0]?.records[1]).toMatchObject({
      id: "event-4",
      summary: "我是 Codex。",
      eventCount: 3,
    });
    expect(model.turns[0]?.records[1]?.payload).not.toHaveProperty("delta");
    expect(model.turns[0]?.records[1]?.sourceEvents.map((source) => source.id)).toEqual([
      "event-2", "event-3", "event-4",
    ]);
  });
});

describe("DSH trajectory canvas", () => {
  it("uses 对话 in the Chinese empty state", () => {
    render(<TrajectoryCanvas events={[]} language="zh" />);

    expect(screen.getByText("当前对话还没有轨迹")).toBeVisible();
  });

  it("renders overview lanes, ledger controls, search, collapse, and record details", async () => {
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={events} language="en" />);

    expect(screen.getByRole("region", { name: "Trajectory timeline" })).toBeVisible();
    expect(screen.getByText("Input")).toBeVisible();
    expect(screen.getByText("Agent")).toBeVisible();
    expect(screen.getByText("Tools")).toBeVisible();
    expect(screen.getByText("System")).toBeVisible();
    expect(screen.queryByRole("row", { name: /USAGE/ })).toBeNull();
    expect(screen.getByRole("row", { name: /TOOL.*read_file/ })).toBeVisible();

    await user.click(screen.getByRole("row", { name: /TOOL.*read_file/ }));
    expect(screen.getByRole("complementary", { name: "Event details" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Summary" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Raw" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Source" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByRole("tabpanel", { name: "Source" })).toHaveTextContent("event-3");

    await user.type(screen.getByRole("searchbox", { name: "Search trajectory" }), "Limited");
    expect(screen.getByRole("row", { name: /WARNING.*Limited metadata/ })).toBeVisible();
    expect(screen.queryByRole("row", { name: /TOOL.*read_file/ })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search trajectory" }));
    await user.click(screen.getByRole("button", { name: "Collapse turns" }));
    expect(screen.queryByRole("row", { name: /TOOL.*read_file/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand turns" }));
    expect(screen.getByRole("row", { name: /TOOL.*read_file/ })).toBeVisible();
  });

  it("puts active visibility controls before trajectory metrics", async () => {
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={events} language="en" />);
    const turns = screen.getByRole("button", { name: "Collapse turns" });
    const calls = screen.getByRole("button", { name: "Collapse calls" });
    const metrics = screen.getByLabelText("Trajectory overview");

    expect(turns.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(turns).toHaveAttribute("aria-pressed", "true");
    await user.click(turns);
    expect(screen.getByRole("button", { name: "Expand turns" })).toHaveAttribute("aria-pressed", "false");
  });

  it("selects a ledger record from the overview timeline", async () => {
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={events} language="en" />);

    await user.click(screen.getByRole("button", { name: /read_file.*source/ }));
    expect(screen.getByRole("complementary", { name: "Event details" })).toHaveTextContent("read_file");
    expect(screen.getByRole("row", { name: /TOOL.*read_file/ })).toHaveAttribute("aria-selected", "true");
  });

  it("focuses ledger records by dragging a timeline interval and clears with Escape", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const view = render(<TrajectoryCanvas events={events} language="en" />);
    const track = screen.getByTestId("trajectory-track");
    const content = screen.getByTestId("trajectory-track-content");
    Object.defineProperty(content, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 900, top: 0, bottom: 50, right: 900, height: 50, x: 0, y: 0, toJSON() {} }),
    });

    fireEvent.pointerDown(content, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(content, { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(content, { pointerId: 1, clientX: 80 });

    expect(screen.getByRole("status", { name: "Selected time range" })).toBeVisible();
    expect(view.container.querySelectorAll('tr[data-timeline-focus="inside"]').length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll('tr[data-timeline-focus="outside"]').length).toBeGreaterThan(0);
    fireEvent.keyDown(track, { key: "Escape" });
    expect(view.container.querySelector('tr[data-timeline-focus]')).toBeNull();
  });

  it("does not create a time selection from the horizontal scroll host", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<TrajectoryCanvas events={events} language="en" />);
    const scrollHost = screen.getByTestId("trajectory-track");

    fireEvent.pointerDown(scrollHost, { pointerId: 1, clientX: 120, button: 0 });
    fireEvent.pointerMove(scrollHost, { pointerId: 1, clientX: 260 });
    fireEvent.pointerUp(scrollHost, { pointerId: 1, clientX: 260 });

    expect(screen.queryByRole("status", { name: "Selected time range" })).toBeNull();
  });

  it("does not open event details from the click synthesized after a range drag", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<TrajectoryCanvas events={events} language="en" />);
    const track = screen.getByTestId("trajectory-track-content");
    const mark = screen.getByRole("button", { name: /read_file.*source/ });
    Object.defineProperty(track, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 900, top: 0, bottom: 50, right: 900, height: 50, x: 0, y: 0, toJSON() {} }),
    });

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, button: 0 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(mark, { pointerId: 1, clientX: 90 });
    fireEvent.click(mark);

    expect(screen.getByRole("status", { name: "Selected time range" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Event details" })).toBeNull();
  });

  it("restores the full timeline by double-clicking the track", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const view = render(<TrajectoryCanvas events={events} language="en" />);
    const track = screen.getByTestId("trajectory-track-content");
    Object.defineProperty(track, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 900, top: 0, bottom: 50, right: 900, height: 50, x: 0, y: 0, toJSON() {} }),
    });
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 400 });

    expect(screen.getByRole("status", { name: "Selected time range" })).toBeVisible();
    fireEvent.doubleClick(track);
    expect(view.container.querySelector('tr[data-timeline-focus]')).toBeNull();
  });

  it("uses fixed-size blocks and gaps without stretching short timelines", () => {
    render(<TrajectoryCanvas events={[
      { ...event(1, "user_message", { text: "Start" }), createdAt: "2026-08-26T08:00:00.000Z" },
      { ...event(2, "reasoning", { summary: "Next" }), createdAt: "2026-08-26T08:00:01.000Z" },
      { ...event(3, "turn_status", { status: "completed" }), createdAt: "2026-08-26T09:00:00.000Z" },
    ]} language="en" />);
    const start = screen.getByRole("button", { name: "USER: Start" });
    const next = screen.getByRole("button", { name: "REASONING: Next" });
    const end = screen.getByRole("button", { name: /STATUS: completed/ });

    expect(start).toHaveStyle({ left: "12px", width: "18px" });
    expect(next).toHaveStyle({ left: "36px", width: "18px" });
    expect(end).toHaveStyle({ left: "60px", width: "18px" });
    expect(screen.getByTestId("trajectory-track-content")).toHaveStyle({ width: "90px" });
  });

  it("grows long timelines horizontally instead of shrinking event blocks", () => {
    const longTimeline = Array.from({ length: 60 }, (_, index) => ({
      ...event(index + 1, "reasoning", { summary: `Step ${index + 1}` }),
      createdAt: new Date(Date.parse("2026-08-26T08:00:00.000Z") + index * 1_000).toISOString(),
    }));
    render(<TrajectoryCanvas events={longTimeline} language="en" />);

    expect(screen.getByTestId("trajectory-track-content")).toHaveStyle({ width: "1458px" });
    const marks = screen.getByTestId("trajectory-track-content").querySelectorAll("button");
    expect(marks[0]).toHaveStyle({ width: "18px" });
    expect(marks[59]).toHaveStyle({ left: "1428px", width: "18px" });
  });

  it("does not repeat semantic titles or invent missing duration in details", async () => {
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={events} language="en" />);
    await user.click(screen.getByRole("row", { name: /USER.*Review the project/ }));
    const details = screen.getByRole("complementary", { name: "Event details" });

    expect(details.querySelector("header strong")).toBeNull();
    expect(details).not.toHaveTextContent("Duration");
    expect(details).not.toHaveTextContent("Source events");
    expect(screen.getByText("Content", { selector: "dt" })).toBeVisible();
    expect(within(details).getByText("Review the project")).toBeVisible();
  });

  it("formats shell content in Summary while keeping native data in Raw", async () => {
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={[event(1, "shell", { command: "git status", aggregated_output: "clean", status: "completed" })]} language="en" />);
    await user.click(screen.getByRole("row", { name: /SHELL.*git status/ }));

    const summary = screen.getByRole("tabpanel", { name: "Summary" });
    expect(summary).toHaveTextContent("$ git status");
    expect(summary).toHaveTextContent("clean");
    expect(summary).not.toHaveTextContent("aggregated_output");
    expect(summary.querySelector(".trajectory-details__formatted")).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByRole("tabpanel", { name: "Raw" })).toHaveTextContent("aggregated_output");
  });

  it("shows the local date, seconds, and timezone for event timestamps", () => {
    render(<TrajectoryCanvas events={events} language="en" />);
    const timestamp = screen.getAllByRole("time")[0];
    expect(timestamp).toHaveTextContent(/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (?:GMT|UTC)/);
    expect(timestamp).toHaveAttribute("title", expect.stringContaining(Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  it("does not render obsolete timeline grid lines", () => {
    const view = render(<TrajectoryCanvas events={events} language="en" />);
    expect(view.container.querySelector(".trajectory-canvas__grid")).toBeNull();
  });

  it("keeps inspector and ledger tags on the same color tokens", () => {
    const css = readStyles();
    expect(css).toContain(".trajectory-details > header .trajectory-row__tag { color: var(--tag-color); background: var(--tag-background); }");
    expect(css).toContain(".trajectory-row__tag--warning { --tag-color: #b74a18; --tag-background: #ffeadc; }");
  });

  it("uses distinct semantic colors for reasoning, assistant, status, warning, and shell", () => {
    const css = readStyles();
    const colors = ["#7d6bc8", "#2f78c4", "#667085", "#d58b12", "#279a88"];
    expect(colors.every((color) => css.includes(color))).toBe(true);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("resizes the local details inspector within the DSH width bounds", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const user = userEvent.setup();
    render(<TrajectoryCanvas events={events} language="en" />);
    await user.click(screen.getByRole("row", { name: /TOOL.*read_file/ }));
    const inspector = screen.getByRole("complementary", { name: "Event details" });
    const handle = screen.getByRole("separator", { name: "Resize event details" });

    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 800 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 650 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 650 });
    expect(inspector).toHaveStyle({ width: "670px" });
  });

  it("keeps selection attached to its event when streaming events append", async () => {
    const user = userEvent.setup();
    const view = render(<TrajectoryCanvas events={events} language="en" />);
    await user.click(screen.getByRole("row", { name: /TOOL.*read_file/ }));
    view.rerender(<TrajectoryCanvas events={[...events, event(10, "assistant_message", { text: "More" })]} language="en" />);
    expect(screen.getByRole("row", { name: /TOOL.*read_file/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: "Event details" })).toHaveTextContent("read_file");
  });
});

function event(sequence: number, type: NormalizedEvent["type"], payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: `event-${sequence}`,
    conversationId: "conversation-1",
    sequence,
    type,
    payload,
    createdAt: `2026-08-26T08:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}
