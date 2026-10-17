#!/usr/bin/env node

import { runDebugWeb } from "./server.js";

export const runEntrypoint = async (): Promise<void> => {
  try {
    await runDebugWeb();
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Debug Web MCP failed: ${message}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  await runEntrypoint();
