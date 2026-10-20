import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserArguments, browserEnvironment, resolveExecutable } from "./executable.js";

const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;
const STOP_TIMEOUT_MS = 2_000;

export interface LaunchedBrowser {
  readonly endpoint: string;
  readonly profileDir: string;
  readonly persistent: boolean;
  readonly pid: number | undefined;
  readonly close: () => Promise<void>;
}

export interface LaunchBrowserOptions {
  readonly url: string;
  readonly executablePath?: string;
  readonly userDataDir?: string;
}

export interface LaunchBrowserDependencies {
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** Read the CDP port Chrome publishes once it is listening. */
export const readDevtoolsPort = async (profileDir: string): Promise<number | undefined> => {
  try {
    const raw = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
    const first = (raw.split(/\r?\n/u)[0] ?? "").trim();
    if (!/^\d+$/u.test(first)) return undefined;
    const port = Number(first);
    return port >= 1 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
};

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForPort = async (
  profileDir: string,
  child: ChildProcess,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<number> => {
  const state: { code?: number | null; error?: Error } = {};
  child.once("exit", (code) => {
    state.code = code;
  });
  child.once("error", (cause) => {
    state.error = cause;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.error !== undefined)
      throw new Error(`Browser failed to start: ${state.error.message}`);
    if (state.code !== undefined)
      throw new Error(
        `Browser exited before its DevTools port was ready (code ${String(state.code)}).`,
      );
    const port = await readDevtoolsPort(profileDir);
    if (port !== undefined) return port;
    await delay(pollIntervalMs);
  }
  throw new Error(
    "Browser did not expose a DevTools port before the timeout (is another Chrome already using this profile?).",
  );
};

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid !== undefined) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already gone.
      }
      resolve();
    }, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
};

const stopBrowser = async (
  child: ChildProcess,
  profileDir: string,
  persistent: boolean,
): Promise<void> => {
  await stopProcess(child);
  if (!persistent)
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
};

/** Launch a disposable Chrome and wait until its CDP endpoint is ready. */
export const launchBrowser = async (
  options: LaunchBrowserOptions,
  dependencies: LaunchBrowserDependencies = {},
): Promise<LaunchedBrowser> => {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const executable = resolveExecutable(
    options.executablePath,
    dependencies.env ?? process.env,
    dependencies.exists,
  );
  const persistent = options.userDataDir !== undefined;
  const profileDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "debug-web-")));
  if (persistent) await mkdir(profileDir, { recursive: true, mode: 0o700 });
  else await chmod(profileDir, 0o700);
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
  const child = spawnProcess(executable, browserArguments(profileDir, options.url), {
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: browserEnvironment(dependencies.env ?? process.env),
  });
  try {
    const port = await waitForPort(
      profileDir,
      child,
      dependencies.readyTimeoutMs ?? READY_TIMEOUT_MS,
      dependencies.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
    return {
      endpoint: `http://127.0.0.1:${String(port)}`,
      profileDir,
      persistent,
      pid: child.pid,
      close: async () => await stopBrowser(child, profileDir, persistent),
    };
  } catch (cause) {
    await stopBrowser(child, profileDir, persistent);
    throw cause;
  }
};
