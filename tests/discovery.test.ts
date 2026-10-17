import { expect, it } from "vitest";

import { discoverCdpEndpoint, pageSocketForTarget } from "../src/cdp/discovery.js";
import { startFakeCdp } from "./fakeCdp.js";

it("binds discovered WebSocket identity to the requested page target", async () => {
  const fake = await startFakeCdp();
  try {
    const discovery = await discoverCdpEndpoint(new URL(fake.endpoint));
    const localTarget = discovery.targets.find((target) => target.id === "local-page");
    expect(localTarget).toBeDefined();
    if (localTarget === undefined) return;
    expect(pageSocketForTarget(new URL(fake.endpoint), localTarget)).toContain(
      "/devtools/page/local-page",
    );
    expect(() =>
      pageSocketForTarget(new URL(fake.endpoint), {
        ...localTarget,
        webSocket: localTarget.webSocket?.replace("local-page", "different-page"),
      }),
    ).toThrow("did not match");
  } finally {
    await fake.close();
  }
});
