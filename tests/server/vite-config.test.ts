import { describe, expect, it } from "vitest";
import { createControlPlanePlugin, replaceControlPlane, resolveWebPort } from "../../vite.config.js";

describe("Vite web port", () => {
  it("uses the CLI --port value for the API Origin allowlist", () => {
    expect(resolveWebPort(undefined, ["node", "vite", "--port", "4173"])).toBe(4173);
    expect(resolveWebPort(undefined, ["node", "vite", "--port=4174"])).toBe(4174);
  });
});

describe("Vite control plane lifecycle", () => {
  it("waits for the previous API before starting its replacement", async () => {
    let finishStop!: () => void;
    const state: { current?: { token: string; url: string; stop(): Promise<void> } } = {
      current: {
        token: "old",
        url: "http://127.0.0.1:6469",
        stop: () => new Promise<void>((resolve) => { finishStop = resolve; }),
      },
    };
    let started = false;
    const replacement = replaceControlPlane(state, async () => {
      started = true;
      return { token: "new", url: "http://127.0.0.1:6469", stop: async () => undefined };
    });

    await Promise.resolve();
    expect(started).toBe(false);
    finishStop();

    await expect(replacement).resolves.toMatchObject({ token: "new" });
    expect(state.current?.token).toBe("new");
  });

  it("awaits API shutdown from the closeBundle hook", async () => {
    let finishStop!: () => void;
    const stop = new Promise<void>((resolve) => { finishStop = resolve; });
    const plugin = createControlPlanePlugin({ token: "test-token", stop: () => stop });
    const closeBundle = plugin.closeBundle as (() => Promise<void>) | undefined;
    let settled = false;

    const closing = closeBundle?.().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishStop();
    await closing;
    expect(settled).toBe(true);
  });
});
