import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerConfig } from "../../src/server/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.AIN_ONE_TOKEN;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ain-one-task3-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("server config token", () => {
  it("persists installation token across restarts in a secure file", () => {
    const dataDir = makeDataDir();

    const first = createServerConfig({ dataDir });
    const second = createServerConfig({ dataDir });

    expect(first.token).toBe(second.token);
    expect(first.token).not.toHaveLength(0);

    const tokenPath = join(dataDir, "install.token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(first.token);
    expect(lstatSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("honors explicit override and env token without changing stored token", () => {
    const dataDir = makeDataDir();
    const tokenPath = join(dataDir, "install.token");
    writeFileSync(tokenPath, "stored-token\n", { mode: 0o600 });

    const override = createServerConfig({ dataDir, token: "override-token" });
    expect(override.token).toBe("override-token");

    process.env.AIN_ONE_TOKEN = "env-token";
    const fromEnv = createServerConfig({ dataDir });
    expect(fromEnv.token).toBe("env-token");

    expect(readFileSync(tokenPath, "utf8").trim()).toBe("stored-token");
  });

  it("repairs permissions to 0600 for an existing non-empty token file", () => {
    const dataDir = makeDataDir();
    const tokenPath = join(dataDir, "install.token");
    writeFileSync(tokenPath, "existing-token\n", { mode: 0o644 });
    chmodSync(tokenPath, 0o644);

    const config = createServerConfig({ dataDir });

    expect(config.token).toBe("existing-token");
    expect(readFileSync(tokenPath, "utf8").trim()).toBe("existing-token");
    expect(lstatSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("fails closed when install.token is a symlink", () => {
    const dataDir = makeDataDir();
    const outsideDir = mkdtempSync(join(tmpdir(), "ain-one-task3-config-outside-"));
    tempDirs.push(outsideDir);

    const outsideSecret = join(outsideDir, "outside-secret.txt");
    writeFileSync(outsideSecret, "outside-token\n", { mode: 0o600 });
    symlinkSync(outsideSecret, join(dataDir, "install.token"));

    expect(() => createServerConfig({ dataDir })).toThrow("install.token must be a regular file");
    expect(readFileSync(outsideSecret, "utf8").trim()).toBe("outside-token");
  });
});
