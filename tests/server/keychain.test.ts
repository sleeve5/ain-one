import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryKeychainAdapter, createKeychain } from "../../src/server/keychain.js";

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

const restoreFns: Array<() => void> = [];

afterEach(() => {
  while (restoreFns.length > 0) {
    restoreFns.pop()?.();
  }
});

describe("keychain", () => {
  it("uses direct security spawn args with shell disabled", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub(calls, {
      "add-generic-password": { code: 0, stdout: "", stderr: "" },
      "find-generic-password": { code: 0, stdout: "stored-secret\n", stderr: "" },
    });

    const keychain = createKeychain({ spawn });

    await keychain.setSecret({
      service: "ain-one.task5",
      account: "plugin://demo",
      secret: "stored-secret",
    });
    await expect(
      keychain.getSecret({
        service: "ain-one.task5",
        account: "plugin://demo",
      }),
    ).resolves.toBe("stored-secret");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/security",
      args: [
        "add-generic-password",
        "-a",
        "plugin://demo",
        "-s",
        "ain-one.task5",
        "-w",
        "stored-secret",
        "-U",
      ],
    });
    expect(calls[0]?.options.shell).toBe(false);

    expect(calls[1]).toMatchObject({
      command: "/usr/bin/security",
      args: [
        "find-generic-password",
        "-a",
        "plugin://demo",
        "-s",
        "ain-one.task5",
        "-w",
      ],
    });
    expect(calls[1]?.options.shell).toBe(false);
  });

  it("supports in-memory adapter for tests without shelling out", async () => {
    const adapter = createInMemoryKeychainAdapter();
    const keychain = createKeychain({ adapter });

    await keychain.setSecret({
      service: "ain-one.task5",
      account: "plugin://local",
      secret: "memory-secret",
    });

    await expect(
      keychain.getSecret({
        service: "ain-one.task5",
        account: "plugin://local",
      }),
    ).resolves.toBe("memory-secret");
  });

  it("redacts secret value from non-zero exit errors", async () => {
    const secret = "do-not-leak";
    const spawn = createSpawnStub([], {
      "add-generic-password": {
        code: 1,
        stdout: "",
        stderr: `failure contains ${secret}`,
      },
    });

    const keychain = createKeychain({ spawn });

    await expect(
      keychain.setSecret({
        service: "ain-one.task5",
        account: "plugin://demo",
        secret,
      }),
    ).rejects.toThrow("security command failed");

    await keychain
      .setSecret({
        service: "ain-one.task5",
        account: "plugin://demo",
        secret,
      })
      .catch((error: unknown) => {
        const message = String(error);
        expect(message.includes(secret)).toBe(false);
      });
  });
});

function createSpawnStub(
  calls: SpawnCall[],
  responses: Record<string, { code: number; stdout: string; stderr: string }>,
) {
  return (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ): EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
  } => {
    calls.push({ command, args: [...args], options: { ...options } });
    const action = args[0] ?? "";
    const response = responses[action] ?? { code: 1, stdout: "", stderr: "unexpected" };

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: () => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => undefined };

    queueMicrotask(() => {
      if (response.stdout.length > 0) {
        child.stdout.emit("data", Buffer.from(response.stdout));
      }
      if (response.stderr.length > 0) {
        child.stderr.emit("data", Buffer.from(response.stderr));
      }
      child.emit("close", response.code);
    });

    return child;
  };
}
