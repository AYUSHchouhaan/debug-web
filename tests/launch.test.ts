import type { ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  browserArguments,
  browserExecutableCandidates,
  resolveExecutable,
} from "../src/browser/executable.js";
import { launchBrowser, readDevtoolsPort } from "../src/browser/launch.js";

interface FakeChild {
  readonly pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  once(event: string, listener: (...args: unknown[]) => void): FakeChild;
  kill(signal?: NodeJS.Signals): boolean;
}

const makeFakeChild = (pid: number): FakeChild => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: FakeChild = {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    once(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return child;
    },
    kill(signal) {
      child.killed = true;
      child.signalCode = signal ?? "SIGTERM";
      for (const listener of listeners.get("exit") ?? []) listener(null, child.signalCode);
      return true;
    },
  };
  return child;
};

it("resolves the browser executable from explicit path, environment, and candidates", () => {
  expect(resolveExecutable("C:\\custom\\chrome.exe", {}, () => true)).toBe(
    "C:\\custom\\chrome.exe",
  );
  expect(
    resolveExecutable(
      undefined,
      { DEBUG_WEB_BROWSER: "C:\\env\\chrome.exe" },
      (path) => path === "C:\\env\\chrome.exe",
    ),
  ).toBe("C:\\env\\chrome.exe");
  expect(() => resolveExecutable("C:\\nope\\chrome.exe", {}, () => false)).toThrow(
    /was not found/u,
  );
  expect(() => resolveExecutable(undefined, {}, () => false)).toThrow(/No Chrome-family browser/u);
  if (process.platform === "win32")
    expect(browserExecutableCandidates({ PROGRAMFILES: "C:\\PF" })).toContain(
      "C:\\PF\\Google\\Chrome\\Application\\chrome.exe",
    );
});

it("builds loopback launch arguments with a disposable profile", () => {
  const args = browserArguments("C:\\profile", "https://example.com/");
  expect(args).toContain("--remote-debugging-address=127.0.0.1");
  expect(args).toContain("--remote-debugging-port=0");
  expect(args).toContain("--user-data-dir=C:\\profile");
  expect(args.at(-1)).toBe("https://example.com/");
});

it("reads the published DevTools port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debug-web-port-"));
  try {
    expect(await readDevtoolsPort(dir)).toBeUndefined();
    await writeFile(join(dir, "DevToolsActivePort"), "12345\n/devtools/browser/abc\n");
    expect(await readDevtoolsPort(dir)).toBe(12345);
    await writeFile(join(dir, "DevToolsActivePort"), "not-a-port\n");
    expect(await readDevtoolsPort(dir)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("launches a disposable browser and stops it on close", async () => {
  const child = makeFakeChild(4321);
  let profileDir: string | undefined;
  const launched = await launchBrowser(
    { url: "https://example.com/", executablePath: process.execPath },
    {
      exists: () => true,
      spawnProcess: (_command, args) => {
        profileDir = args
          .find((arg) => arg.startsWith("--user-data-dir="))
          ?.slice("--user-data-dir=".length);
        if (profileDir !== undefined)
          writeFileSync(join(profileDir, "DevToolsActivePort"), "52341\n/devtools/browser/x\n");
        return child as unknown as ChildProcess;
      },
    },
  );
  expect(launched.endpoint).toBe("http://127.0.0.1:52341");
  expect(launched.pid).toBe(4321);
  expect(profileDir).toBeDefined();
  expect(existsSync(join(profileDir ?? "missing", "DevToolsActivePort"))).toBe(true);

  await launched.close();
  expect(child.killed).toBe(true);
  expect(existsSync(profileDir ?? "missing")).toBe(false);
});
