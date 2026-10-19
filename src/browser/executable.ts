import { existsSync } from "node:fs";
import { join } from "node:path";

/** Candidate browser executables for the current platform, in preference order. */
export const browserExecutableCandidates = (
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] => {
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  if (process.platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
};

/** Resolve the Chrome-family executable to launch. */
export const resolveExecutable = (
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string => {
  const requested = override === undefined || override === "" ? env.DEBUG_WEB_BROWSER : override;
  if (requested !== undefined && requested !== "") {
    if (!exists(requested)) throw new Error(`Browser executable was not found at "${requested}".`);
    return requested;
  }
  const found = browserExecutableCandidates(env).find(exists);
  if (found === undefined)
    throw new Error(
      "No Chrome-family browser was found. Pass executable_path or set DEBUG_WEB_BROWSER.",
    );
  return found;
};

/** Launch arguments: loopback debugging on an OS-assigned port, disposable profile. */
export const browserArguments = (profileDir: string, url: string): readonly string[] => [
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-dev-shm-usage",
  "--disable-sync",
  "--password-store=basic",
  url,
];

const ALLOWED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "windir",
  "LANG",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
] as const;

/** A minimal environment so the launched browser does not inherit ambient secrets. */
export const browserEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = env[key];
    if (value !== undefined) allowed[key] = value;
  }
  return allowed;
};
