import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationCanvas } from "../../src/web/components/conversation-canvas.js";
import type { ConversationView } from "../../src/web/api.js";

const conversation: ConversationView = {
  id: "conversation-1",
  projectId: "project-1",
  title: "Review frontend",
  agentProductId: "codex",
  agentProductLabel: "Codex",
  modelId: "gpt-5",
  permissionMode: "request_approval",
  availableModels: ["gpt-5", "gpt-5-mini"],
  availablePermissionModes: ["request_approval", "help_me_approve", "full_access"],
  enabledPluginIds: [],
  availablePlugins: [],
  activeTurnStatus: null,
  latestTurnId: "turn-1",
  latestTurnStatus: "completed",
  queuePaused: false,
  queuedMessages: [],
  events: [
    { id: "1", conversationId: "conversation-1", sequence: 1, type: "user_message", payload: { text: "Please review this" }, createdAt: "2026-08-24T06:32:07.000Z" },
    { id: "2", conversationId: "conversation-1", sequence: 2, type: "tool", payload: { id: "call-1", name: "read_file", input: { path: "src/web/app.tsx" }, status: "started" }, createdAt: "2026-08-24T06:32:08.000Z" },
    { id: "3", conversationId: "conversation-1", sequence: 3, type: "tool", payload: { id: "call-1", status: "completed", result: "export function App()" }, createdAt: "2026-08-24T06:32:09.000Z" },
    { id: "4", conversationId: "conversation-1", sequence: 4, type: "warning", payload: { message: "Limited metadata" }, createdAt: "2026-08-24T06:32:10.000Z" },
    { id: "5", conversationId: "conversation-1", sequence: 5, type: "assistant_message", payload: { text: "Review complete" }, createdAt: "2026-08-24T06:32:11.000Z" },
    { id: "6", conversationId: "conversation-1", sequence: 6, type: "turn_status", payload: { turnId: "turn-1", status: "completed" }, createdAt: "2026-08-24T06:32:12.000Z" },
  ],
};

function renderCanvas(conversationValue: ConversationView = conversation) {
  const onChangeModel = vi.fn();
  const onChangePermissionMode = vi.fn();
  const onForkConversation = vi.fn(async () => undefined);
  const onRespondToPermission = vi.fn(async () => undefined);
  const onResolveUncertainMessage = vi.fn(async () => undefined);
  const result = render(
    <ConversationCanvas
      conversation={conversationValue}
      language="zh"
      onChangeModel={onChangeModel}
      onChangePermissionMode={onChangePermissionMode}
      onDeletePendingMessage={async () => undefined}
      onResolveUncertainMessage={onResolveUncertainMessage}
      onQueueMessage={async () => undefined}
      onCancelTurn={async () => undefined}
      onContinueConversation={async () => undefined}
      onRetryInterruptedTurn={async () => undefined}
      onRespondToPermission={onRespondToPermission}
      onForkConversation={onForkConversation}
    />,
  );
  return { ...result, onChangeModel, onChangePermissionMode, onForkConversation, onRespondToPermission, onResolveUncertainMessage };
}

describe("DSH conversation surface", () => {
  it("offers explicit accept or retry recovery for an uncertain delivery", async () => {
    const user = userEvent.setup();
    const { onResolveUncertainMessage } = renderCanvas({
      ...conversation,
      queuedMessages: [{
        id: "uncertain-message", content: "possibly delivered", status: "uncertain",
        deliveryId: "delivery-1", createdAt: "2026-08-24T06:32:13.000Z",
      }],
      events: [...conversation.events, {
        id: "uncertain-user", conversationId: conversation.id, sequence: 7, type: "user_message",
        payload: { text: "possibly delivered", messageId: "uncertain-message" },
        createdAt: "2026-08-24T06:32:13.000Z",
      }],
    });

    expect(screen.getByText("投递结果待确认")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete pending message/ })).toBeNull();
    expect(screen.getAllByText("possibly delivered")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "确认已接收" }));
    await user.click(screen.getByRole("button", { name: "重新发送" }));
    expect(onResolveUncertainMessage).toHaveBeenNthCalledWith(1, "uncertain-message", "accept");
    expect(onResolveUncertainMessage).toHaveBeenNthCalledWith(2, "uncertain-message", "retry");
  });

  it("uses a two-row header with title and Agent above the canvas tabs", () => {
    const css = readStyles();

    expect(css).toMatch(/\.workspace__toolbar\s*\{[^}]*flex-direction:\s*column;/s);
    expect(css).toMatch(/\.workspace__conversation-title\s*\{[^}]*min-height:\s*48px;/s);
    expect(css).toMatch(/\.canvas-switch\s*\{[^}]*height:\s*42px;/s);
  });

  it("uses readable high-frequency action sizes", () => {
    const css = readStyles();

    expect(css).toMatch(/\.conversation-message__actions button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
    expect(css).toMatch(/\.project-sidebar__workspace-heading button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
    expect(css).toMatch(/\.project-sidebar__footer svg\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
    expect(css).toMatch(/\.project-sidebar__opening\s*\{[^}]*height:\s*32px;[^}]*align-items:\s*center;[^}]*font-size:\s*12px;/s);
    expect(css).toMatch(/\.project-sidebar__workspace-heading\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s);
  });

  it("keeps the composer actions right-aligned even without a stop control", () => {
    const css = readStyles();

    expect(css).toMatch(/\.composer__controls\s*\{[^}]*flex:\s*1;/s);
    expect(css).toMatch(/\.project-sidebar__project-button\[data-active="true"\]\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*color:\s*var\(--accent-strong\);/s);
  });

  it("keeps the composer outside the scrolling message region", () => {
    const { container } = renderCanvas();
    const canvas = container.querySelector(".conversation-canvas");
    const scroll = container.querySelector(".conversation-canvas__scroll");
    const seat = container.querySelector(".conversation-canvas__composer-seat");

    expect(seat?.parentElement).toBe(canvas);
    expect(scroll?.contains(seat)).toBe(false);
  });

  it("uses the DSH composer control order without pretending attachment support", () => {
    const { container } = renderCanvas();
    const footer = container.querySelector(".composer__footer");
    const labels = [...footer!.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.getAttribute("aria-label"));

    expect(screen.getByRole("button", { name: "添加附件（当前版本暂不支持）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加附件（当前版本暂不支持）" })).toHaveAttribute("data-tooltip");
    expect(labels).toEqual(["添加附件（当前版本暂不支持）", "Permission mode", "Agent", "Model", "Send message"]);
  });

  it("keeps stop inside the composer and never places it in the header", async () => {
    const user = userEvent.setup();
    const onCancelTurn = vi.fn(async () => undefined);
    const { container } = render(
      <ConversationCanvas
        conversation={{ ...conversation, activeTurnStatus: "running" }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={onCancelTurn}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop.closest(".composer")).not.toBeNull();
    expect(container.querySelector(".conversation-canvas__header .composer__stop")).toBeNull();
    await user.click(stop);
    expect(onCancelTurn).toHaveBeenCalledOnce();
  });

  it("does not retain the removed header stop layout rule", () => {
    expect(readStyles()).not.toContain(".workspace__conversation-title .conversation-canvas__stop");
  });

  it("shows one timestamp only after the Turn ends and keeps activity collapsed", async () => {
    const user = userEvent.setup();
    renderCanvas();

    expect(screen.getByText("Please review this")).toBeVisible();
    expect(screen.getByText("Review complete")).toBeVisible();
    expect(screen.queryByText(/14:32:07/)).toBeNull();
    expect(screen.queryByText(/14:32:11/)).toBeNull();
    expect(screen.getAllByText(/14:32:12/)).toHaveLength(1);
    expect(screen.queryByText("read_file")).toBeNull();

    await user.click(screen.getByRole("button", { name: "展开执行轨迹" }));
    expect(screen.getByText(/read_file.*completed/)).toBeVisible();
    expect(screen.getByText(/src\/web\/app\.tsx/)).toBeVisible();
    expect(screen.getByText(/export function App/)).toBeVisible();
    expect(screen.getAllByText(/read_file/)).toHaveLength(1);
    expect(screen.getByText("Limited metadata")).toBeVisible();
    expect(screen.getByText("Limited metadata").closest("li")).toHaveAttribute(
      "data-severity",
      "warning",
    );
    expect(screen.queryByText(/tokens|缓存命中|tok\/s/i)).toBeNull();
  });

  it("keeps usage out of activity and shows observed tokens in the Turn footer", async () => {
    const user = userEvent.setup();
    renderCanvas({
      ...conversation,
      events: [
        conversation.events[0]!,
        { id: "reasoning", conversationId: conversation.id, sequence: 2, type: "reasoning", payload: { summary: "Inspecting" }, createdAt: "2026-08-24T06:32:08.000Z" },
        { ...conversation.events[4]!, payload: { text: "Review complete", final: true } },
        { id: "usage", conversationId: conversation.id, sequence: 6, type: "usage", payload: { input_tokens: 120, output_tokens: 34 }, createdAt: "2026-08-24T06:32:11.500Z" },
        { ...conversation.events[5]!, sequence: 7 },
      ],
    });

    expect(screen.getAllByRole("button", { name: "展开执行轨迹" })).toHaveLength(1);
    expect(screen.getByText(/输入 120 · 输出 34 tokens/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "展开执行轨迹" }));
    expect(screen.queryByText("用量")).toBeNull();
  });

  it("shows useful fallback content for native warnings", async () => {
    const user = userEvent.setup();
    renderCanvas({
      ...conversation,
      events: [
        conversation.events[0]!,
        { id: "warning-native", conversationId: conversation.id, sequence: 2, type: "warning", payload: { code: "unknown_native_event", event: '{"type":"future.event"}' }, createdAt: "2026-08-24T06:32:08.000Z" },
        conversation.events[5]!,
      ],
    });

    await user.click(screen.getByRole("button", { name: "展开执行轨迹" }));
    expect(screen.getByText(/unknown_native_event.*future.event/)).toBeVisible();
  });

  it("keeps activity details horizontal and joins timeline nodes with a rail", () => {
    const css = readStyles();
    expect(css).toMatch(/\.conversation-trajectory__detail\s*\{[^}]*width:\s*100%;[^}]*overflow-wrap:\s*break-word;/s);
    expect(css).toMatch(/\.conversation-trajectory li:not\(:last-child\) \.conversation-canvas__event-dot::after\s*\{/s);
    expect(css).toMatch(/\.conversation-message__actions \[data-tooltip\]::after\s*\{[^}]*background:\s*#253143;[^}]*z-index:\s*80;/s);
  });

  it("renders Markdown semantics without interpreting raw HTML", () => {
    render(
      <ConversationCanvas
        conversation={{
          ...conversation,
          events: [
            { id: "md-1", conversationId: conversation.id, sequence: 1, type: "assistant_message", payload: { text: "**Bold** and `inline`\n\n- first\n- second\n\n```ts\nconst value = 1;\n```\n<script>alert('x')</script>" }, createdAt: "2026-08-24T06:32:11.000Z" },
            { id: "md-2", conversationId: conversation.id, sequence: 2, type: "turn_status", payload: { turnId: "turn-md", status: "completed" }, createdAt: "2026-08-24T06:32:12.000Z" },
          ],
        }}
        language="en"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(screen.getByText("inline").tagName).toBe("CODE");
    expect(screen.getByText("first").tagName).toBe("LI");
    expect(screen.getByText("const value = 1;").closest("pre")).not.toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>/)).toBeVisible();
  });

  it("replaces an active-writer stderr dump with an actionable Turn error", () => {
    render(
      <ConversationCanvas
        conversation={{
          ...conversation,
          events: [{
            id: "conflict", conversationId: conversation.id, sequence: 1, type: "turn_status",
            payload: { status: "interrupted", error: { code: "process_exit", message: "thread-store conflict: thread native-session already has an active writer\ninternal detail" } },
            createdAt: "2026-08-24T06:32:11.000Z",
          }],
        }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
      />,
    );

    expect(screen.getByText("Agent 对话仍被其他进程占用，请重启项目后重试。")).toBeVisible();
    expect(screen.queryByText(/thread-store conflict/)).toBeNull();
  });

  it("keeps each question's activity before its answer during one long-lived Trae Turn", async () => {
    const user = userEvent.setup();
    render(
      <ConversationCanvas
        conversation={{
          ...conversation,
          events: [
            conversation.events[0]!,
            conversation.events[1]!,
            conversation.events[4]!,
            { ...conversation.events[0]!, id: "question-2", sequence: 6, payload: { text: "next task" } },
            { ...conversation.events[3]!, id: "warning-2", sequence: 7, payload: { message: "second warning" } },
            { ...conversation.events[4]!, id: "answer-2", sequence: 8, payload: { text: "second answer" } },
          ],
        }}
        language="en"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    const questions = screen.getAllByRole("article");
    const activities = screen.getAllByRole("button", { name: "Expand activity" });
    expect(activities).toHaveLength(2);
    expect(questions[0]!.compareDocumentPosition(activities[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activities[0]!.compareDocumentPosition(questions[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(questions[2]!.compareDocumentPosition(activities[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activities[1]!.compareDocumentPosition(questions[3]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(activities[1]!);
    expect(screen.getByText("second warning")).toBeVisible();
    expect(screen.queryByText("Limited metadata")).toBeNull();
  });

  it.each([
    ["starting", "正在连接"],
    ["running", "正在分析"],
    ["cancelling", "正在停止"],
  ] as const)("shows immediate feedback while a Turn is %s", (status, label) => {
    render(
      <ConversationCanvas
        conversation={{ ...conversation, activeTurnStatus: status, latestTurnStatus: status }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(label);
  });

  it("places model and the three approved permission labels in the composer", async () => {
    const user = userEvent.setup();
    const { onChangeModel, onChangePermissionMode } = renderCanvas();

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByRole("menuitemradio", { name: "gpt-5-mini" }));
    expect(onChangeModel).toHaveBeenCalledWith("gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByRole("menuitemradio", { name: "需要审批" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "自动审批" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "完全访问" })).toBeVisible();
    await user.click(screen.getByRole("menuitemradio", { name: "自动审批" }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("help_me_approve");
  });

  it("shows a pending approval as an actionable conversation prompt", async () => {
    const user = userEvent.setup();
    const pendingApproval = {
      ...conversation,
      activeTurnStatus: "running" as const,
      events: [
        ...conversation.events.slice(0, -1),
        { id: "approval", conversationId: conversation.id, sequence: 6, type: "permission" as const, payload: { requestId: "approval-1", request: "Run pwd" }, createdAt: "2026-08-24T06:32:12.000Z" },
      ],
    };
    const { onRespondToPermission } = renderCanvas(pendingApproval);

    expect(screen.getByText("Run pwd")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "允许一次" }));
    expect(onRespondToPermission).toHaveBeenCalledWith("approval-1", "allow_once");
  });

  it("does not show an approval from an already finished Turn", () => {
    renderCanvas({
      ...conversation,
      events: [
        { id: "approval", conversationId: conversation.id, sequence: 1, type: "permission", payload: { requestId: "approval-1", request: "Old request" }, createdAt: "2026-08-24T06:32:11.000Z" },
        { id: "terminal", conversationId: conversation.id, sequence: 2, type: "turn_status", payload: { turnId: "turn-old", status: "cancelled" }, createdAt: "2026-08-24T06:32:12.000Z" },
      ],
    });

    expect(screen.queryByText("Old request")).toBeNull();
  });

  it("closes composer menus on outside click and has no decorative diamond separator", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menu")).toBeVisible();

    await user.click(screen.getByRole("heading", { name: "Review frontend" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(container).not.toHaveTextContent("◇");
  });

  it("shows the current Agent as a disabled fixed selector for an existing conversation", () => {
    renderCanvas();

    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
    expect(document.querySelector(".conversation-canvas__agent")).toHaveTextContent("Codex");
  });

  it("uses aligned SVG chevrons and fixed composer control slots", () => {
    const { container } = renderCanvas();
    const css = readStyles();

    expect(screen.getByRole("button", { name: "Agent" }).querySelector(".selector-chevron")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Model" }).querySelector(".selector-chevron")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Permission mode" }).querySelector(".selector-chevron")).not.toBeNull();
    expect(container.querySelectorAll(".selector-chevron svg")).toHaveLength(3);
    expect(container.querySelector(".conversation-trajectory__chevron svg")).not.toBeNull();
    expect(css).toContain(".agent-selector { width: 128px; }");
    expect(css).toContain(".composer-selector { width: 152px; }");
    expect(css).toContain(".permission-selector { width: 132px; }");
    expect(css).toContain(".composer__stop { width: 76px;");
  });

  it("opens both composer menus above the bottom composer", () => {
    renderCanvas();
    const css = readStyles();

    expect(css).toMatch(/\.composer-popover\s*\{[^}]*bottom:\s*34px;/s);
    expect(css).toMatch(/\.composer__input:focus-visible\s*\{[^}]*outline:\s*0;/s);
  });

  it("shows copy and branch actions for assistant output", async () => {
    const user = userEvent.setup();
    const { onForkConversation } = renderCanvas();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const copyButton = screen.getByRole("button", { name: "复制输出" });
    expect(copyButton).toHaveAttribute("data-tooltip", "复制输出");
    expect(copyButton.querySelector("svg")).not.toBeNull();
    expect(copyButton).not.toHaveTextContent("▢");
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith("Review complete");
    const branchButton = screen.getByRole("button", { name: "新对话分支" });
    expect(branchButton).toHaveAttribute("data-tooltip", "新对话分支");
    expect(branchButton.querySelector("svg")).not.toBeNull();
    await user.click(branchButton);
    expect(onForkConversation).toHaveBeenCalledOnce();
  });

  it("clears the composer as soon as sending starts", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onQueueMessage = vi.fn(async () => pending);
    render(
      <ConversationCanvas
        conversation={conversation}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
      />,
    );

    const message = screen.getByRole("textbox", { name: "消息" });
    await user.type(message, "立即清空");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onQueueMessage).toHaveBeenCalledWith("立即清空", expect.any(Function));
    expect(message).toHaveValue("");
    finish();
  });

  it("offers copy and resend actions on user messages", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onQueueMessage = vi.fn(async () => pending);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <ConversationCanvas
        conversation={conversation}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
      />,
    );

    const copy = screen.getByRole("button", { name: "复制消息" });
    const resend = screen.getByRole("button", { name: "重新发送消息" });
    expect(copy).toHaveAttribute("data-tooltip", "复制消息");
    expect(resend).toHaveAttribute("data-tooltip", "重新发送消息");
    await user.click(copy);
    await user.click(resend);

    expect(writeText).toHaveBeenCalledWith("Please review this");
    expect(onQueueMessage).toHaveBeenCalledWith("Please review this");
    await user.type(screen.getByRole("textbox", { name: "消息" }), "下一条");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    finish();
  });

  it("renders a legacy interruption after a final answer as completed", () => {
    renderCanvas({
      ...conversation,
      latestTurnStatus: "interrupted",
      events: [
        conversation.events[0]!,
        { ...conversation.events[4]!, payload: { ...conversation.events[4]!.payload, final: true } },
        { ...conversation.events[5]!, payload: { turnId: "turn-1", status: "interrupted" } },
      ],
    });

    expect(screen.getByText("已完成")).toBeVisible();
    expect(screen.queryByText(/interrupted/)).toBeNull();
  });

  it("keeps an interruption when activity follows a complete assistant item", () => {
    renderCanvas({
      ...conversation,
      latestTurnStatus: "interrupted",
      events: [
        conversation.events[0]!,
        { ...conversation.events[4]!, payload: { ...conversation.events[4]!.payload, final: true } },
        conversation.events[1]!,
        { ...conversation.events[5]!, payload: { turnId: "turn-1", status: "interrupted" } },
      ],
    });

    expect(screen.getByText("结束: interrupted")).toBeVisible();
  });

  it("shows progress and prevents duplicate branches while branching", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onForkConversation = vi.fn(async () => pending);
    render(
      <ConversationCanvas
        conversation={conversation}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
        onForkConversation={onForkConversation}
      />,
    );

    const button = screen.getByRole("button", { name: "新对话分支" });
    await user.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("正在创建分支…")).toBeVisible();
    await user.click(button);
    expect(onForkConversation).toHaveBeenCalledOnce();
    finish();
  });

  it("submits Enter when idle and keeps Shift+Enter for a newline", async () => {
    const user = userEvent.setup();
    const onQueueMessage = vi.fn(async () => undefined);
    render(
      <ConversationCanvas
        conversation={conversation}
        language="en"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    const message = screen.getByLabelText("Message");
    await user.type(message, "send now{enter}");
    expect(onQueueMessage).toHaveBeenCalledWith("send now", expect.any(Function));

    await user.type(message, "line one{shift>}{enter}{/shift}line two");
    expect(message).toHaveValue("line one\nline two");
  });

  it("uses the compact agent id as the conversation tag", () => {
    renderCanvas();

    const agentBadge = document.querySelector(".conversation-canvas__agent");
    expect(agentBadge).toHaveTextContent("Codex");
    expect(agentBadge).toHaveAttribute("data-agent", "codex");
    expect(screen.queryByText("codex")).toBeNull();
  });

  it("does not expose the Trae queue waiting state", () => {
    render(
      <ConversationCanvas
        conversation={{
      ...conversation,
      agentProductId: "trae",
      activeTurnStatus: "starting",
      events: [
        {
          id: "assistant-current",
          conversationId: conversation.id,
          sequence: 1,
          type: "assistant_message",
          payload: { text: "已完成" },
          createdAt: "2026-08-24T10:00:00.000Z",
        },
        { id: "queue-waiting", conversationId: conversation.id, sequence: 2, type: "queue_status", payload: { status: "waiting", hasPendingInput: false }, createdAt: "2026-08-24T10:00:01.000Z" },
      ]}}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在连接");
    expect(screen.queryByText("等待中，无需排队，请直接发送任务")).toBeNull();
    expect(screen.queryByRole("button", { name: "取消等待" })).toBeNull();
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
  });

  it("does not infer Queue waiting from an assistant response", () => {
    renderCanvas({
      ...conversation,
      agentProductId: "trae",
      activeTurnStatus: "running",
      events: [{ id: "assistant-current", conversationId: conversation.id, sequence: 1, type: "assistant_message", payload: { text: "仍在回复" }, createdAt: "2026-08-24T10:00:00.000Z" }],
    });

    expect(screen.getByRole("status")).toHaveTextContent("正在分析");
    expect(screen.queryByText("等待中，无需排队，请直接发送任务")).toBeNull();
  });

  it("blocks active sends for Trae", async () => {
    const user = userEvent.setup();
    const onQueueMessage = vi.fn(async () => undefined);
    render(
      <ConversationCanvas
        conversation={{ ...conversation, agentProductId: "trae", activeTurnStatus: "running", latestTurnStatus: "running" }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "下一项任务");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{enter}");
    expect(onQueueMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["Codex", { agentProductId: "codex" as const }],
    ["Trae", { agentProductId: "trae" as const }],
  ])("blocks active sends for %s", async (_label, settings) => {
    const onQueueMessage = vi.fn(async () => undefined);
    render(
      <ConversationCanvas
        conversation={{ ...conversation, ...settings, activeTurnStatus: "running", latestTurnStatus: "running" }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    await userEvent.setup().type(screen.getByLabelText("消息"), "不可插入");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(onQueueMessage).not.toHaveBeenCalled();
  });

  it("does not expose Auto queue for Trae", () => {
    renderCanvas({ ...conversation, agentProductId: "trae" });

    expect(screen.queryByRole("button", { name: "自动排队" })).toBeNull();
  });

  it("returns to analyzing after a follow-up is delivered to the waiting Trae turn", () => {
    renderCanvas({
      ...conversation,
      agentProductId: "trae",
      activeTurnStatus: "running",
      events: [
        { id: "assistant-current", conversationId: conversation.id, sequence: 1, type: "assistant_message", payload: { text: "上一轮结果" }, createdAt: "2026-08-24T10:00:00.000Z" },
        { id: "user-follow-up", conversationId: conversation.id, sequence: 2, type: "user_message", payload: { text: "继续处理" }, createdAt: "2026-08-24T10:00:01.000Z" },
      ],
    });

    expect(screen.getByRole("status")).toHaveTextContent("正在分析");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("blocks sending while a legacy Trae Hook is waiting", async () => {
    const user = userEvent.setup();
    const onQueueMessage = vi.fn(async () => undefined);
    render(
      <ConversationCanvas
        conversation={{
          ...conversation,
          agentProductId: "trae",
          activeTurnStatus: "running",
          events: [
            { id: "assistant-current", conversationId: conversation.id, sequence: 1, type: "assistant_message", payload: { text: "已完成" }, createdAt: "2026-08-24T10:00:00.000Z" },
            { id: "queue-waiting", conversationId: conversation.id, sequence: 2, type: "queue_status", payload: { status: "waiting", hasPendingInput: false }, createdAt: "2026-08-24T10:00:01.000Z" },
          ],
        }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={onQueueMessage}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "下一步");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{enter}");
    expect(onQueueMessage).not.toHaveBeenCalled();
  });

  it("does not accept another message while a legacy Hook already has pending input", async () => {
    const onQueueMessage = vi.fn(async () => undefined);
    render(<ConversationCanvas conversation={{ ...conversation, agentProductId: "trae", activeTurnStatus: "running", events: [{ id: "queue-waiting", conversationId: conversation.id, sequence: 1, type: "queue_status", payload: { status: "waiting", hasPendingInput: true }, createdAt: "2026-08-24T10:00:01.000Z" }] }} language="zh" onChangeModel={() => undefined} onChangePermissionMode={() => undefined} onDeletePendingMessage={async () => undefined} onQueueMessage={onQueueMessage} onCancelTurn={async () => undefined} onContinueConversation={async () => undefined} onRetryInterruptedTurn={async () => undefined} />);

    await userEvent.setup().type(screen.getByLabelText("消息"), "排在后面{enter}");
    expect(onQueueMessage).not.toHaveBeenCalled();
  });

  it("renders a pending message only in the queue when a legacy user event has the same message id", () => {
    renderCanvas({
      ...conversation,
      queuedMessages: [{ id: "pending-1", content: "只显示一次", status: "pending", deliveryId: null, createdAt: "2026-08-24T10:00:00.000Z" }],
      events: [{ id: "legacy-event", conversationId: conversation.id, sequence: 1, type: "user_message", payload: { text: "只显示一次", messageId: "pending-1" }, createdAt: "2026-08-24T10:00:00.000Z" }],
    });

    expect(screen.getAllByText("只显示一次")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete pending message 1: 只显示一次" })).toBeVisible();
  });

  it("offers a conversation-local scroll-to-bottom control", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const scroll = container.querySelector(".conversation-canvas__scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    scroll.scrollTo = scrollTo;
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 1200 });

    await user.click(screen.getByRole("button", { name: "滑到底部" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
  });

  it("smoothly aligns the latest user prompt when a Turn finishes", async () => {
    const running = {
      ...conversation,
      activeTurnStatus: "running" as const,
      latestTurnStatus: "running" as const,
      events: [
        ...conversation.events,
        { id: "7", conversationId: conversation.id, sequence: 7, type: "user_message" as const, payload: { text: "Latest prompt" }, createdAt: "2026-08-24T06:33:00.000Z" },
        { id: "8", conversationId: conversation.id, sequence: 8, type: "assistant_message" as const, payload: { text: "Latest answer" }, createdAt: "2026-08-24T06:33:01.000Z" },
      ],
    };
    const { rerender } = renderCanvas(running);
    const latestPrompt = screen.getByText("Latest prompt").closest("article") as HTMLElement;
    const scrollIntoView = vi.fn();
    latestPrompt.scrollIntoView = scrollIntoView;

    rerender(
      <ConversationCanvas
        conversation={{ ...running, activeTurnStatus: null, latestTurnStatus: "completed" }}
        language="zh"
        onChangeModel={() => undefined}
        onChangePermissionMode={() => undefined}
        onDeletePendingMessage={async () => undefined}
        onQueueMessage={async () => undefined}
        onCancelTurn={async () => undefined}
        onContinueConversation={async () => undefined}
        onRetryInterruptedTurn={async () => undefined}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" }));
  });
});

function readStyles(): string {
  return readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
}
