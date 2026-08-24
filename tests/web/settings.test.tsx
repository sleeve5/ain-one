import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/web/components/settings.js";
import { PluginSettings } from "../../src/web/components/plugin-settings.js";

describe("Settings", () => {
  it("shows truthful Agent details and only catalog-supported permission modes", () => {
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
          {
            id: "opencode",
            name: "OpenCode",
            status: "not_installed",
            diagnostic: "opencode executable is not installed",
            catalog: { models: [], permissionModes: [] },
          },
        ]}
        onSaveExecutablePath={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(screen.getByText("Codex is available")).toBeVisible();
    expect(screen.getByText("Version: 0.147.0")).toBeVisible();
    expect(screen.getByText("Executable: /usr/local/bin/codex")).toBeVisible();
    expect(screen.getByText("Native login is available")).toBeVisible();
    expect(screen.getByText("gpt-5")).toBeVisible();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
    expect(screen.getByText("Request approval")).toBeVisible();
    expect(screen.getByText("Full access")).toBeVisible();
    expect(screen.queryByText("Help me approve")).not.toBeInTheDocument();
    expect(screen.getByText("Could not refresh one optional alias")).toBeVisible();

    expect(screen.queryByText("OpenCode is not installed")).toBeNull();
    expect(screen.queryByText("opencode executable is not installed")).toBeNull();
  });

  it("submits an executable path override for the selected Agent Product", async () => {
    const user = userEvent.setup();
    const onSaveExecutablePath = vi.fn();
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
      />,
    );

    const input = screen.getByLabelText("Claude Code executable path override");
    expect(input).toHaveValue("/opt/claude");
    await user.clear(input);
    await user.type(input, "/custom/claude");
    await user.click(screen.getByRole("button", { name: "Save Claude Code path" }));

    expect(onSaveExecutablePath).toHaveBeenCalledWith("claude", "/custom/claude");
  });
});

describe("PluginSettings", () => {
  it("shows installed versions and import candidates with explicit compatibility", async () => {
    const user = userEvent.setup();
    const onAcceptCandidate = vi.fn();
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
        importCandidates={[
          {
            candidateId: "candidate-1",
            pluginId: "reviewer",
            versionId: "sha-1",
            type: "skill",
            sourceAgent: "trae",
            compatibleAgents: ["trae"],
          },
        ]}
        scope="global"
        enabledVersions={[]}
        enablementsLocked={false}
        onAcceptCandidate={onAcceptCandidate}
        onInstallLocalPath={vi.fn()}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={onRefreshImports}
      />,
    );

    expect(screen.getByText("Plugin: formatter")).toBeVisible();
    expect(screen.getByText("Version: v2")).toBeVisible();
    expect(screen.getAllByText("Type: skill")).toHaveLength(2);
    expect(screen.getByText("Compatible agents: Codex, Claude Code")).toBeVisible();
    expect(screen.getByText("Compatible agents: None declared")).toBeVisible();
    expect(screen.getByLabelText("Enable local-mcp sha-2")).toBeDisabled();
    expect(screen.getByText("Unavailable in Phase 1")).toBeVisible();
    expect(screen.getByText("Codex: Materialized")).toBeVisible();
    expect(screen.getByText("Claude Code: Not materialized")).toBeVisible();
    expect(screen.getByRole("button", { name: "Repair formatter v2 for Claude Code" })).toBeVisible();
    expect(screen.getByText("Source agent: Trae")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Accept reviewer sha-1" }));
    expect(onAcceptCandidate).toHaveBeenCalledWith("candidate-1");
    await user.click(screen.getByRole("button", { name: "Refresh imports" }));
    expect(onRefreshImports).toHaveBeenCalledOnce();
  });

  it("installs a local path and reports scope-specific enablement without conversion", async () => {
    const user = userEvent.setup();
    const onInstallLocalPath = vi.fn();
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
        importCandidates={[]}
        scope="project"
        enabledVersions={[]}
        enablementsLocked={false}
        onAcceptCandidate={vi.fn()}
        onInstallLocalPath={onInstallLocalPath}
        onScopeChange={onScopeChange}
        onEnableChange={onEnableChange}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Local plugin path"), "/tmp/my-skill");
    await user.click(screen.getByLabelText("Compatible with Codex"));
    await user.click(screen.getByLabelText("Compatible with Claude Code"));
    await user.click(screen.getByRole("button", { name: "Install local plugin" }));
    expect(onInstallLocalPath).toHaveBeenCalledWith(
      "/tmp/my-skill",
      "skill",
      ["codex", "claude"],
    );
    expect(screen.queryByLabelText("Compatible with OpenCode")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Plugin scope"), "conversation");
    expect(onScopeChange).toHaveBeenCalledWith("conversation");

    await user.click(screen.getByLabelText("Enable formatter v2"));
    expect(onEnableChange).toHaveBeenCalledWith("project", {
      pluginId: "formatter",
      versionId: "v2",
      enabled: true,
    });
  });

  it("disables enablement changes while the selected scope has active Turns", () => {
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
        importCandidates={[]}
        scope="global"
        enabledVersions={[]}
        enablementsLocked
        onAcceptCandidate={vi.fn()}
        onInstallLocalPath={vi.fn()}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Enable formatter v2")).toBeDisabled();
    expect(screen.getByText(/active Turns must finish/i)).toBeVisible();
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
        importCandidates={[]}
        scope="conversation"
        conversationAgentProductId="claude"
        enabledVersions={[]}
        enablementsLocked={false}
        onAcceptCandidate={vi.fn()}
        onInstallLocalPath={vi.fn()}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Enable codex-only v1")).toBeDisabled();
    expect(screen.getByText("Incompatible with Claude Code")).toBeVisible();
  });

  it("installs MCP definitions without pretending Skill compatibility applies", async () => {
    const user = userEvent.setup();
    const onInstallLocalPath = vi.fn();
    render(
      <PluginSettings
        installedVersions={[]}
        importCandidates={[]}
        scope="global"
        enabledVersions={[]}
        enablementsLocked={false}
        onAcceptCandidate={vi.fn()}
        onInstallLocalPath={onInstallLocalPath}
        onScopeChange={vi.fn()}
        onEnableChange={vi.fn()}
        onRepairMaterialization={vi.fn()}
        onRefreshImports={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Local plugin type"), "mcp");
    await user.type(screen.getByLabelText("Local plugin path"), "/tmp/mcp.json");
    await user.click(screen.getByRole("button", { name: "Install local plugin" }));

    expect(onInstallLocalPath).toHaveBeenCalledWith("/tmp/mcp.json", "mcp", []);
    expect(screen.getByLabelText("Compatible with Codex")).toBeDisabled();
  });
});
