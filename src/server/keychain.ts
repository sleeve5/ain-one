import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

export interface KeychainSecretRef {
  service: string;
  account: string;
}

export interface SetSecretInput extends KeychainSecretRef {
  secret: string;
}

export interface Keychain {
  setSecret(input: SetSecretInput): Promise<void>;
  getSecret(input: KeychainSecretRef): Promise<string>;
}

export interface KeychainAdapter {
  setSecret(input: SetSecretInput): Promise<void>;
  getSecret(input: KeychainSecretRef): Promise<string>;
}

type MinimalChildProcess = {
  stdout?: { on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown };
  stderr?: { on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown };
  on: (event: "error" | "close", listener: (...args: unknown[]) => void) => unknown;
};

export type SpawnLike = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => MinimalChildProcess;

export interface CreateKeychainOptions {
  adapter?: KeychainAdapter;
  spawn?: SpawnLike;
}

export function createKeychain(options: CreateKeychainOptions = {}): Keychain {
  const spawn: SpawnLike =
    options.spawn ??
    ((command, args, spawnOptions) =>
      nodeSpawn(command, args, spawnOptions as SpawnOptions) as unknown as MinimalChildProcess);
  const adapter = options.adapter ?? createSecurityKeychainAdapter(spawn);
  return {
    async setSecret(input) {
      await adapter.setSecret(input);
    },
    async getSecret(input) {
      return adapter.getSecret(input);
    },
  };
}

export function createInMemoryKeychainAdapter(): KeychainAdapter {
  const store = new Map<string, string>();
  return {
    async setSecret(input) {
      store.set(keyOf(input), input.secret);
    },
    async getSecret(input) {
      const value = store.get(keyOf(input));
      if (value == null) {
        throw new Error("secret not found");
      }
      return value;
    },
  };
}

function createSecurityKeychainAdapter(spawn: SpawnLike): KeychainAdapter {
  return {
    async setSecret(input) {
      await runSecurityCommand({
        spawn,
        args: [
          "add-generic-password",
          "-a",
          input.account,
          "-s",
          input.service,
          "-w",
          input.secret,
          "-U",
        ],
        redactions: [input.secret],
      });
    },
    async getSecret(input) {
      const result = await runSecurityCommand({
        spawn,
        args: ["find-generic-password", "-a", input.account, "-s", input.service, "-w"],
      });
      const secret = result.stdout.trim();
      if (secret.length === 0) {
        throw new Error("security command failed: empty secret");
      }
      return secret;
    },
  };
}

async function runSecurityCommand(input: {
  spawn: SpawnLike;
  args: string[];
  redactions?: string[];
}): Promise<{ stdout: string; stderr: string }> {
  const child = input.spawn("/usr/bin/security", input.args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on("data", (chunk) => {
    stdoutChunks.push(toBuffer(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    stderrChunks.push(toBuffer(chunk));
  });

  const code = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      resolvePromise(typeof exitCode === "number" ? exitCode : 1);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (code !== 0) {
    const output = redact([stdout, stderr].filter((part) => part.length > 0).join(" "), input.redactions);
    const normalized = output.trim().length > 0 ? output.trim() : `exit code ${code}`;
    throw new Error(`security command failed: ${normalized}`);
  }

  return { stdout, stderr };
}

function keyOf(input: KeychainSecretRef): string {
  return `${input.service}\u0000${input.account}`;
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function redact(value: string, redactions: string[] | undefined): string {
  if (!redactions || redactions.length === 0) {
    return value;
  }

  let current = value;
  for (const token of redactions) {
    if (token.length === 0) {
      continue;
    }
    current = current.split(token).join("[REDACTED]");
  }
  return current;
}
