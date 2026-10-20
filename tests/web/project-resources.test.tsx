import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphProject } from "../../src/shared/contracts.js";
import { ProjectSidebar } from "../../src/web/components/project-sidebar.js";

const graph = {
  id: "g1", projectId: "p1", name: "Review workflow", description: "",
  definition: { nodes: [], edges: [], start: [], end: [] },
  viewport: { x: 0, y: 0, zoom: 1 }, positions: {},
  createdAt: "2026-08-27T09:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z",
} satisfies GraphProject;

describe("project resource sidebar", () => {
  it("uses 对话 consistently in the Chinese interface", async () => {
    const user = userEvent.setup();
    render(<ProjectSidebar
      projects={[{ id: "p1", name: "ain-one", path: "/tmp/ain-one", archivedAt: null }]}
      graphs={[]}
      conversations={[{ id: "c1", projectId: "p1", title: "测试对话" } as never]}
      selectedProjectId="p1" selectedConversationId="c1"
      onOpenProject={vi.fn()} onRestartWorkspace={vi.fn()} onCreateConversation={vi.fn()}
      onSelectProject={vi.fn()} onSelectConversation={vi.fn()} onOpenSettings={vi.fn()}
      collapsed={false} onToggleCollapsed={vi.fn()} language="zh"
    />);

    expect(screen.getByRole("navigation", { name: "项目与对话" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "管理对话 测试对话" }));
    expect(screen.getByRole("button", { name: "分叉对话" })).toBeVisible();
    expect(screen.getByRole("button", { name: "归档对话" })).toBeVisible();
  });

  it("shows one activity-sorted resource list with a type badge on every row", async () => {
    const user = userEvent.setup();
    const onCreateGraph = vi.fn();
    const onSelectGraph = vi.fn();
    render(<ProjectSidebar
      projects={[{ id: "p1", name: "ain-one", path: "/tmp/ain-one", archivedAt: null }]}
      graphs={[graph]}
      conversations={[{ id: "c1", projectId: "p1", title: "Graph entry design" } as never]}
      selectedProjectId="p1" selectedConversationId={null} selectedGraphId="g1"
      onOpenProject={vi.fn()} onRestartWorkspace={vi.fn()} onCreateConversation={vi.fn()}
      onCreateGraph={onCreateGraph} onSelectProject={vi.fn()} onSelectConversation={vi.fn()}
      onSelectGraph={onSelectGraph} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapsed={vi.fn()} language="en"
    />);

    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New graph" }));
    expect(onCreateGraph).toHaveBeenCalledOnce();
    const list = screen.getByRole("list", { name: "Project resources" });
    expect(within(list).getByText("Review workflow")).toBeVisible();
    expect(within(list).getByText("Graph entry design")).toBeVisible();
    expect(screen.getAllByText("Graph")).toHaveLength(1);
    expect(screen.getAllByText("Chat")).toHaveLength(1);
    expect(screen.queryByText(/10:00/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review workflow" }));
    expect(onSelectGraph).toHaveBeenCalledWith("g1");
  });

  it("renames, branches, and archives a Graph from its row menu", async () => {
    const user = userEvent.setup();
    const onRenameGraph = vi.fn(async () => undefined);
    const onForkGraph = vi.fn(async () => undefined);
    const onArchiveGraph = vi.fn(async () => undefined);
    render(<ProjectSidebar
      projects={[{ id: "p1", name: "ain-one", path: "/tmp/ain-one", archivedAt: null }]} graphs={[graph]} conversations={[]}
      selectedProjectId="p1" selectedConversationId={null} selectedGraphId="g1"
      onOpenProject={vi.fn()} onRestartWorkspace={vi.fn()} onCreateConversation={vi.fn()} onSelectProject={vi.fn()} onSelectConversation={vi.fn()} onOpenSettings={vi.fn()}
      onRenameGraph={onRenameGraph} onForkGraph={onForkGraph} onArchiveGraph={onArchiveGraph}
      collapsed={false} onToggleCollapsed={vi.fn()} language="en"
    />);

    await user.click(screen.getByRole("button", { name: "Manage graph Review workflow" }));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("dialog", { name: "Rename graph" }).querySelector("input")!;
    await user.clear(input); await user.type(input, "Pipeline");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameGraph).toHaveBeenCalledWith("g1", "Pipeline");

    await user.click(screen.getByRole("button", { name: "Manage graph Review workflow" }));
    await user.click(screen.getByRole("button", { name: "Branch graph" }));
    expect(onForkGraph).toHaveBeenCalledWith("g1");
    await user.click(screen.getByRole("button", { name: "Manage graph Review workflow" }));
    await user.click(screen.getByRole("button", { name: "Archive graph" }));
    expect(onArchiveGraph).toHaveBeenCalledWith("g1");
  });

  it("searches graph names and keeps Graph before Chat", async () => {
    const user = userEvent.setup();
    render(<ProjectSidebar
      projects={[{ id: "p1", name: "ain-one", path: "/tmp/ain-one", archivedAt: null }]} graphs={[graph]}
      conversations={[{ id: "c1", projectId: "p1", title: "Chat only" } as never]} selectedProjectId="p1" selectedConversationId={null}
      onOpenProject={vi.fn()} onRestartWorkspace={vi.fn()} onCreateConversation={vi.fn()} onSelectProject={vi.fn()} onSelectConversation={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapsed={vi.fn()} language="en"
    />);
    await user.click(screen.getByRole("button", { name: "Search projects" }));
    await user.type(screen.getByLabelText("Search projects, graphs, and chats"), "Review");
    expect(screen.getByRole("button", { name: "Review workflow" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Chat only" })).not.toBeInTheDocument();
  });
});
