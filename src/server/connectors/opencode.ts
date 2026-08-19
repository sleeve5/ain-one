import type {
  AgentCatalog,
  AgentProbe,
  ConnectorEvent,
  LiveSession,
  NormalizedError,
  SessionInput,
  StartTurnInput,
  TerminalTurnStatus,
} from "../../shared/contracts.js";
import {
  BaseConnector,
  type ActiveTurnController,
  type BaseConnectorOptions,
  type RuntimeSession,
  UnsupportedCapabilityError,
} from "./base.js";

export interface OpenCodeSdkTurn extends ActiveTurnController {}

export interface OpenCodeSdkAdapter {
  probe(): Promise<AgentProbe>;
  fetchCatalog(projectPath: string): Promise<AgentCatalog>;
  createOrResumeSession(input: SessionInput): Promise<{ nativeSessionId: string | null }>;
  startTurn(
    session: LiveSession,
    input: StartTurnInput,
    sink: {
      emitEvent: (event: ConnectorEvent) => Promise<void>;
      syncNativeSessionId: (nativeSessionId: string | null) => Promise<void>;
      emitTerminal: (input: {
        turnId: string | undefined;
        nativeTurnId: string | null;
        status: TerminalTurnStatus;
        error?: NormalizedError;
      }) => Promise<void>;
    },
  ): Promise<OpenCodeSdkTurn>;
}

export interface OpenCodeConnectorOptions extends BaseConnectorOptions {
  sdkAdapter?: OpenCodeSdkAdapter;
}

export class OpenCodeConnector extends BaseConnector {
  readonly id = "opencode" as const;
  private readonly sdkAdapter?: OpenCodeSdkAdapter;

  constructor(options: OpenCodeConnectorOptions = {}) {
    super(options);
    this.sdkAdapter = options.sdkAdapter;
  }

  protected defaultExecutable(): string {
    return "opencode";
  }

  async probe(): Promise<AgentProbe> {
    if (!this.sdkAdapter) {
      return {
        status: "not_installed",
        diagnostic: "@opencode-ai/sdk is not installed",
      };
    }
    return this.sdkAdapter.probe();
  }

  async fetchCatalog(projectPath: string): Promise<AgentCatalog> {
    if (!this.sdkAdapter) {
      return {
        models: [],
        permissionModes: [],
      };
    }
    return this.sdkAdapter.fetchCatalog(projectPath);
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    const runtime = this.createRuntimeSession(input);
    if (!this.sdkAdapter) {
      return runtime;
    }

    const session = await this.sdkAdapter.createOrResumeSession(input);
    runtime.nativeSessionId = session.nativeSessionId;
    return runtime;
  }

  async startTurn(session: LiveSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }> {
    if (!this.sdkAdapter) {
      throw new UnsupportedCapabilityError(
        "opencode_sdk",
        "@opencode-ai/sdk is required to start OpenCode sessions",
      );
    }

    const runtime = this.asRuntimeSession(session);
    if (runtime.activeTurn) {
      const error = new Error("Turn already active") as Error & { definiteStartRejection?: boolean };
      error.definiteStartRejection = true;
      throw error;
    }

    const activeTurn = await this.sdkAdapter.startTurn(session, input, {
      emitEvent: async (event) => {
        await this.emitEvent(runtime, event);
      },
      syncNativeSessionId: async (nativeSessionId) => {
        await this.syncNativeSessionId(runtime, nativeSessionId);
      },
      emitTerminal: async (terminal) => {
        await this.emitTerminal(runtime, terminal);
      },
    });

    runtime.activeTurn = activeTurn;
    runtime.settled = activeTurn.settled.finally(() => {
      if (runtime.activeTurn?.settled === activeTurn.settled) {
        delete runtime.activeTurn;
      }
    });

    return { nativeTurnId: activeTurn.nativeTurnId };
  }
}
