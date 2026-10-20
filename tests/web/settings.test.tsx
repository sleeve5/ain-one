import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/web/components/settings.js";
import { PluginSettings } from "../../src/web/components/plugin-settings.js";
import { AppSettings } from "../../src/web/components/app-settings.js";
import { ArchivedSettings } from "../../src/web/components/archived-settings.js";
import { GeneralSettings } from "../../src/web/components/general-settings.js";

describe("GeneralSettings", () => {
  it("does not expose queue-specific busy Enter behavior", () => {
    render(<GeneralSettings value={{ language: "zh", appearance: "light", defaultPermissionMode: "request_approval" }} onChange={vi.fn()} />);

    expect(screen.queryByLabelText("Enter behavior while busy")).toBeNull();
    expect(screen.queryByText("排队发送")).toBeNull();
    expect(screen.getByText("这些偏好应用于项目和之后新建的对话。")).toBeVisible();
    expect(screen.queryByText(/工作台/)).toBeNull();
  });
});

describe("Settings", () => {
  it("uses the canonical Agent labels and order", () => {
    render(
      <Settings
        agents={[
          { id: "trae", name: "Trae", status: "available", catalog: { models: [], permissionModes: [] } },
          { id: "claude", name: "Claude", status: "available", catalog: { models: [], permissionModes: [] } },
          { id: "codex", name: "codex-cli", status: "available", catalog: { models: [], permissionModes: [] } },
        ]}
        onSaveExecutablePath={vi.fn()}
        onPickExecutablePath={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "EnabledCodex", "EnabledClaude Code", "EnabledTrae CLI",
    ]);
  });

  it("shows a capability-limited Agent as enabled without internal diagnostics", () => {
    render(
      <Settings
        language="zh"
        agents={[{
          id: "codex",
          name: "Codex",
          status: "capability_limited",
          catalog: { models: ["gpt-5.6-sol"], permissionModes: ["request_approval"] },
        }]}
        onSaveExecutablePath={vi.fn()}
        onPickExecutablePath={vi.fn()}
      />,
    );

    expect(screen.getByText("已启用")).toBeVisible();
    expect(screen.getByText("已启用")).toHaveClass("settings__agent-state--enabled");
    expect(screen.getByText("gpt-5.6-sol")).toBeVisible();
    expect(screen.queryByText(/部分交互受限/)).toBeNull();
  });

  it("shows compact Agent details and catalog models", () => {
    render(
      <Settings
        agents={[
          {
            id: "codex",
            name: "Codex",
            status: "available",
            version: "0.147.0",
            executablePath: "/usr/local/bin/codex",
            diagnostic: "Native login is available",
            catalog: {
              models: ["gpt-5", "gpt-5-mini"],
              permissionModes: ["request_approval", "full_access"],
              error: "Could not refresh one optional alias",
            },
          },
        ]}
        onSaveExecutablePath={vi.fn()}
        onPickExecutablePath={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(screen.getByText("Enabled")).toBeVisible();
    expect(screen.getByText("Version: 0.147.0")).toBeVisible();
    expect(screen.queryByText("Path: /usr/local/bin/codex")).toBeNull();
    expect(screen.queryByText("Native login is available")).toBeNull();
    expect(screen.getByText("gpt-5")).toBeVisible();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
    expect(screen.queryByText("Could not refresh one optional alias")).toBeNull();

  });

  it("selects an executable and disables an Agent without removing its path", async () => {
    const user = userEvent.setup();
    const onSaveExecutablePath = vi.fn();
    const onSetEnabled = vi.fn();
    const onPickExecutablePath = vi.fn(async () => "/custom/claude");
    render(
      <Settings
        agents={[
          {
            id: "claude",
            name: "Claude Code",
            status: "available",
            executablePath: "/usr/local/bin/claude",
            executablePathOverride: "/opt/claude",
            catalog: { models: ["sonnet"], permissionModes: ["request_approval"] },
          },
        ]}
        onSaveExecutablePath={onSaveExecutablePath}
        onPickExecutablePath={onPickExecutablePath}
        onSetEnabled={onSetEnabled}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Import another Claude Code path" }));

    expect(onPickExecutablePath).toHaveBeenCalledWith("claude");
    expect(onSaveExecutablePath).toHaveBeenCalledWith("claude", "/custom/claude");
    await user.click(screen.getByRole("button", { name: "Disable Claude Code" }));
    expect(onSetEnabled).toHaveBeenCalledWith("claude", false);
    expect(onSaveExecutablePath).not.toHaveBeenCalledWith("claude", null);
  });
});

describe("PluginSettings", () => {
  it("uses the latest plugin version without exposing a version picker or opaque ids", async () => {
    const onEnableChange = vi.fn();
    render(
      <PluginSettings
        installedVersions={[
          { pluginId: "argos", versionId: "old-content-hash", version: "1.9.0", type: "skill", compatibleAgents: ["codex", "claude", "trae"], materializations: [] },
          { pluginId: "argos", versionId: "new-content-hash", version: "1.10.0", type: "skill", compatibleAgents: ["codex", "claude", "trae"], materializations: [{ agentProductId: "codex", status: "not_materialized", repairable: true }] },
          { pluginId: "opaque", versionId: "536465d88e52b18b", type: "skill", compatibleAgents: ["codex"], materializations: [] },
        ]}
        scope="global" enabledVersions={[{ pluginId: "argos", versionId: "old-content-hash" }]}
        onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()} onScopeChange={vi.fn()} onEnableChange={onEnableChange} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getAllByText("argos")).toHaveLength(1);
    expect(screen.queryByLabelText("Version for argos")).not.toBeInTheDocument();
    expect(screen.getByText("1.10.0")).toBeVisible();
    expect(screen.queryByText("1.9.0")).not.toBeInTheDocument();
    expect(screen.queryByText(/536465/)).not.toBeInTheDocument();
    expect(screen.queryByText("Sync")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair argos for Codex" })).toHaveTextContent("Repair Codex");
    expect(screen.getByLabelText("Enable argos")).toBeChecked();
    expect(screen.queryByLabelText(/content-hash/)).not.toBeInTheDocument();
    expect(onEnableChange).toHaveBeenCalledWith("global", { pluginId: "argos", versionId: "new-content-hash", enabled: true });
  });

  it("requests each automatic version migration only once across parent rerenders", () => {
    const installedVersions = [
      { pluginId: "argos", versionId: "old-content-hash", version: "1.9.0", type: "skill" as const, compatibleAgents: ["codex" as const], materializations: [] },
      { pluginId: "argos", versionId: "new-content-hash", version: "1.10.0", type: "skill" as const, compatibleAgents: ["codex" as const], materializations: [] },
    ];
    const enabledVersions = [{ pluginId: "argos", versionId: "old-content-hash" }];
    const firstChange = vi.fn();
    const view = render(
      <PluginSettings
        installedVersions={installedVersions}
        scope="global"
        enabledVersions={enabledVersions}
        onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()} onScopeChange={vi.fn()}
        onEnableChange={firstChange} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    expect(firstChange).toHaveBeenCalledOnce();

    const rerenderedChange = vi.fn();
    view.rerender(
      <PluginSettings
        installedVersions={installedVersions}
        scope="global"
        enabledVersions={enabledVersions}
        onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()} onScopeChange={vi.fn()}
        onEnableChange={rerenderedChange} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    expect(rerenderedChange).not.toHaveBeenCalled();
  });

  it("never presents the internal version id as a user-facing version", () => {
    render(
      <PluginSettings
        installedVersions={[{ pluginId: "internal", versionId: "1.2.3", type: "skill", compatibleAgents: ["codex"], materializations: [] }]}
        scope="global" enabledVersions={[]} onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()} onEnableChange={vi.fn()} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getByText("internal")).toBeVisible();
    expect(screen.queryByText("1.2.3")).not.toBeInTheDocument();
  });

  it("sorts compatible Agent badges in the canonical order", () => {
    render(
      <PluginSettings
        installedVersions={[{ pluginId: "ordered", versionId: "v1", type: "skill", compatibleAgents: ["trae", "claude", "codex"], materializations: [] }]}
        scope="global" enabledVersions={[]} onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()} onEnableChange={vi.fn()} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/Codex|Claude Code|Trae CLI/).map((badge) => badge.textContent)).toEqual(["Codex", "Claude Code", "Trae CLI"]);
  });

  it("shows one user-facing inventory without asking to re-import discovered plugins", async () => {
    const user = userEvent.setup();
    const onRefreshImports = vi.fn();
    render(
      <PluginSettings
        installedVersions={[
          {
            pluginId: "formatter",
            versionId: "v2",
            type: "skill",
            compatibleAgents: ["codex", "claude"],
            materializations: [
              { agentProductId: "codex", status: "materialized", repairable: false },
              { agentProductId: "claude", status: "not_materialized", repairable: true },
            ],
          },
          {
            pluginId: "local-mcp",
            versionId: "sha-2",
            type: "mcp",
            compatibleAgents: [],
            materializations: [],
          },
        ]}
        scope="global"
        enabledVersions={[{ pluginId: "formatter", versionId: "v2" }]}
        onInstallLocalPath={vi.fn()}
        onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={onRefreshImports}
      />,
    );

    expect(screen.getByText("formatter")).toBeVisible();
    expect(screen.getByText(/automatically discovered/i)).toBeVisible();
    expect(screen.queryByText("v2")).not.toBeInTheDocument();
    expect(screen.getByText("Skill")).toHaveClass("plugin-settings__kind");
    expect(screen.getByText("Codex")).toHaveAttribute("data-agent", "codex");
    expect(screen.getByText("Claude Code")).toHaveAttribute("data-agent", "claude");
    expect(screen.getByRole("button", { name: "Repair formatter for Claude Code" })).toBeVisible();
    expect(screen.getByLabelText("Enable formatter")).toBeChecked();
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(screen.queryByRole("region", { name: "Plugin import candidates" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "MCP" }));
    expect(screen.getByText("local-mcp")).toBeVisible();
    expect(screen.getByLabelText("Enable local-mcp")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Auto import" }));
    expect(onRefreshImports).toHaveBeenCalledOnce();
  });

  it("filters the available plugin list by name", async () => {
    const user = userEvent.setup();
    render(
      <PluginSettings
        installedVersions={[
          { pluginId: "formatter", versionId: "v1", type: "skill", compatibleAgents: ["codex"], materializations: [] },
          { pluginId: "reviewer", versionId: "v1", type: "skill", compatibleAgents: ["trae"], materializations: [] },
        ]}
        scope="global" enabledVersions={[]}
        onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()} onEnableChange={vi.fn()} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search plugins" }), "review");
    expect(screen.queryByText("formatter")).toBeNull();
    expect(screen.getByText("reviewer")).toBeVisible();
  });

  it("picks a local path and reports scope-specific enablement without conversion", async () => {
    const user = userEvent.setup();
    const onInstallLocalPath = vi.fn();
    const onPickLocalPath = vi.fn(async () => "/tmp/my-skill");
    const onScopeChange = vi.fn();
    const onEnableChange = vi.fn();
    render(
      <PluginSettings
        installedVersions={[
          {
            pluginId: "formatter",
            versionId: "v2",
            type: "skill",
            compatibleAgents: ["codex"],
            materializations: [
              { agentProductId: "codex", status: "not_materialized", repairable: true },
            ],
          },
        ]}
        scope="project"
        enabledVersions={[]}
        onInstallLocalPath={onInstallLocalPath}
        onPickLocalPath={onPickLocalPath}
        onScopeChange={onScopeChange}
        onEnableChange={onEnableChange}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Skill" }));
    expect(onPickLocalPath).toHaveBeenCalledWith("directory");
    expect(onInstallLocalPath).toHaveBeenCalledWith(
      "/tmp/my-skill",
      "skill",
      ["codex", "claude", "trae"],
    );
    expect(screen.queryByLabelText("Compatible with OpenCode")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Plugin scope"), "conversation");
    expect(onScopeChange).toHaveBeenCalledWith("conversation");

    await user.click(screen.getByLabelText("Enable formatter"));
    expect(onEnableChange).toHaveBeenCalledWith("project", {
      pluginId: "formatter",
      versionId: "v2",
      enabled: true,
    });
  });

  it("allows changing the next Turn's enablements while another Turn is active", () => {
    render(
      <PluginSettings
        installedVersions={[
          {
            pluginId: "formatter",
            versionId: "v2",
            type: "skill",
            compatibleAgents: ["codex"],
            materializations: [],
          },
        ]}
        scope="global"
        enabledVersions={[]}
        onInstallLocalPath={vi.fn()}
        onPickLocalPath={vi.fn(async () => "/tmp/mcp.json")}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Enable formatter")).toBeEnabled();
    expect(screen.queryByText(/active Turns must finish/i)).toBeNull();
  });

  it("disables plugins incompatible with the selected Conversation Agent Product", () => {
    render(
      <PluginSettings
        installedVersions={[
          {
            pluginId: "codex-only",
            versionId: "v1",
            type: "skill",
            compatibleAgents: ["codex"],
            materializations: [],
          },
        ]}
        scope="conversation"
        conversationAgentProductId="claude"
        enabledVersions={[]}
        onInstallLocalPath={vi.fn()}
        onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Enable codex-only")).toBeDisabled();
  });

  it("installs MCP definitions without pretending Skill compatibility applies", async () => {
    const user = userEvent.setup();
    const onInstallLocalPath = vi.fn();
    render(
      <PluginSettings
        installedVersions={[]}
        scope="global"
        enabledVersions={[]}
        onInstallLocalPath={onInstallLocalPath}
        onPickLocalPath={vi.fn(async () => "/tmp/mcp.json")}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Add MCP" }));

    expect(onInstallLocalPath).toHaveBeenCalledWith("/tmp/mcp.json", "mcp", []);
    expect(screen.queryByLabelText("Compatible with Codex")).toBeNull();
  });

  it("sorts compact plugin rows by name", () => {
    render(
      <PluginSettings
        installedVersions={[
          { pluginId: "zeta", versionId: "1", type: "skill", compatibleAgents: ["codex"], materializations: [] },
          { pluginId: "alpha", versionId: "1", type: "skill", compatibleAgents: ["codex"], materializations: [] },
        ]}
        scope="global" enabledVersions={[]}
        onInstallLocalPath={vi.fn()} onPickLocalPath={vi.fn()}
        onScopeChange={vi.fn()} onEnableChange={vi.fn()} onRepairMaterialization={vi.fn()} onRefreshImports={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("alpha"), expect.stringContaining("zeta")]),
    );
    const rows = screen.getByRole("region", { name: "Installed plugin versions" }).querySelectorAll(":scope > ul > li");
    expect(rows[0]).toHaveTextContent("alpha");
    expect(rows[1]).toHaveTextContent("zeta");
  });
});

describe("AppSettings plugin layout", () => {
  it("uses the canonical Agent label in Chinese navigation", () => {
    render(
      <AppSettings
        open
        section="general"
        language="zh"
        general={null}
        agents={null}
        plugins={null}
        archived={null}
        onSectionChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Agent" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  });

  it("marks the Plugin body so only its inventory needs to scroll", () => {
    render(
      <AppSettings
        open
        section="plugins"
        language="en"
        general={null}
        agents={null}
        plugins={<section>Plugin inventory</section>}
        archived={null}
        onSectionChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Plugin inventory").parentElement).toHaveAttribute("data-section", "plugins");
  });
});

describe("ArchivedSettings", () => {
  it("groups archived Graphs and Chats under their Project without global duplicate sections", () => {
    render(<ArchivedSettings language="en" state={{
      projects: [{ id: "project-1", name: "Alpha", path: "/tmp/alpha", archivedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
      projectNames: { "project-1": "Alpha", "project-2": "Beta" },
      conversations: [{ id: "conversation-1", projectId: "project-1", title: "Old chat", agentProductId: "codex", modelId: null, permissionMode: "request_approval", queuePaused: false, archivedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
      graphs: [{ id: "graph-1", projectId: "project-2", name: "Old graph", description: "", definition: { nodes: [], edges: [], start: [], end: [] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: {}, archivedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
    }} onRestoreProject={vi.fn()} onRestoreConversation={vi.fn()} onRestoreGraph={vi.fn()} onDeleteConversation={vi.fn()} />);

    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAccessibleName("Alpha");
    expect(groups[0]).toHaveTextContent("ChatOld chat");
    expect(groups[1]).toHaveAccessibleName("Beta");
    expect(groups[1]).toHaveTextContent("GraphOld graph");
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Graphs" })).toBeNull();
  });

  it("uses an in-app confirmation before permanently deleting an archived Conversation", async () => {
    const user = userEvent.setup();
    const onDeleteConversation = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, "confirm");
    render(
      <ArchivedSettings
        language="en"
        state={{ projects: [], conversations: [{
          id: "conversation-1", projectId: "project-1", title: "Old chat", agentProductId: "codex", modelId: null,
          permissionMode: "request_approval", queuePaused: false, archivedAt: "2026-08-24T00:00:00.000Z",
          createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
        }] }}
        onRestoreProject={vi.fn()}
        onRestoreConversation={vi.fn()}
        onDeleteConversation={onDeleteConversation}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete Old chat permanently" }));
    expect(confirm).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Delete archived conversation" });
    expect(dialog).toBeVisible();
    expect(dialog.parentElement).toHaveClass("client-dialog");
    expect(dialog).toHaveClass("client-dialog__panel");
    expect(screen.getByText(/Permanently delete .*Old chat/)).toBeVisible();
    expect(onDeleteConversation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm permanent deletion" }));
    expect(onDeleteConversation).toHaveBeenCalledWith("conversation-1");
    confirm.mockRestore();
  });

  it("uses an in-app confirmation before deleting an archived Project from the client", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn(async () => undefined);
    render(<ArchivedSettings language="en" state={{
      projects: [{ id: "project-1", name: "Old project", path: "/tmp/keep-me", archivedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
      conversations: [],
    }} onRestoreProject={vi.fn()} onRestoreConversation={vi.fn()} onDeleteConversation={vi.fn()} onDeleteProject={onDeleteProject}/>);

    await user.click(screen.getByRole("button", { name: "Delete Old project from Ain One" }));
    expect(screen.getByRole("dialog", { name: "Delete archived project" })).toBeVisible();
    expect(screen.getByText(/local files will not be deleted/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm project deletion" }));
    expect(onDeleteProject).toHaveBeenCalledWith("project-1");
  });

  it("keeps active resources inside an archived Project under Project-level actions", () => {
    render(<ArchivedSettings language="en" state={{
      projects: [{ id: "project-1", name: "Old project", path: "/tmp/keep-me", archivedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
      conversations: [{ id: "conversation-1", projectId: "project-1", title: "Project chat", agentProductId: "codex", modelId: null, permissionMode: "request_approval", queuePaused: false, archivedAt: null, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
      graphs: [{ id: "graph-1", projectId: "project-1", name: "Project graph", description: "", definition: { nodes: [], edges: [], start: [], end: [] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: {}, archivedAt: null, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }],
    }} onRestoreProject={vi.fn()} onRestoreConversation={vi.fn()} onRestoreGraph={vi.fn()} onDeleteConversation={vi.fn()} onDeleteGraph={vi.fn()} />);

    expect(screen.getByText("Project chat")).toBeVisible();
    expect(screen.getByText("Project graph")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Project chat permanently" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Project graph permanently" })).toBeNull();
  });
});
