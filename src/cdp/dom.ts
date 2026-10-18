import type { DomNode, DomSnapshotResult } from "../types.js";
import type { CdpConnection } from "./connection.js";

const TEXT_NODE_TYPE = 3;

export interface DomCaptureOptions {
  readonly maxNodes: number;
  readonly includeAttributeValues: boolean;
  readonly includeText: boolean;
  readonly maxBytes: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

/** Capture one page's DOM through CDP without evaluating JavaScript. */
export const captureDomSnapshot = async (
  connection: CdpConnection,
  options: DomCaptureOptions,
): Promise<DomSnapshotResult> => {
  await connection.send("Page.enable");
  await connection.send("DOM.enable");
  const document = await connection.send("DOM.getDocument", {
    depth: -1,
    pierce: false,
  });
  const root = asRecord(document.root);
  if (root === undefined) throw new Error("CDP DOM.getDocument returned no document to inspect.");

  const captured: DomNode[] = [];
  let byteLength = 0;
  let truncated = false;

  const walk = (raw: unknown, parentIndex: number): void => {
    if (truncated) return;
    const node = asRecord(raw);
    if (node === undefined) return;
    if (captured.length >= options.maxNodes || byteLength >= options.maxBytes) {
      truncated = true;
      return;
    }
    const flat = asArray(node.attributes).flatMap((item) =>
      typeof item === "string" ? [item] : [],
    );
    const attributeNames: string[] = [];
    const attributeValues: Record<string, string> = {};
    for (let offset = 0; offset + 1 < flat.length; offset += 2) {
      const name = flat[offset] ?? "";
      attributeNames.push(name);
      if (options.includeAttributeValues) attributeValues[name] = flat[offset + 1] ?? "";
    }
    const nodeType = asNumber(node.nodeType) ?? 0;
    const value = asString(node.nodeValue);
    const index = captured.length;
    const entry: DomNode = {
      index,
      parent_index: parentIndex,
      node_type: nodeType,
      node_name: asString(node.nodeName),
      attribute_names: attributeNames,
      ...(options.includeAttributeValues ? { attribute_values: attributeValues } : {}),
      ...(options.includeText && nodeType === TEXT_NODE_TYPE && value !== ""
        ? { text: value }
        : {}),
      text_length: Buffer.byteLength(value, "utf8"),
    };
    byteLength += Buffer.byteLength(JSON.stringify(entry), "utf8");
    captured.push(entry);
    for (const child of asArray(node.children)) walk(child, index);
  };

  walk(root, -1);

  return {
    nodes: captured,
    total_nodes: captured.length,
    truncated,
    byte_length: byteLength,
    limitations: truncated
      ? [
          "DOM output was truncated at the requested node or byte limit; later nodes were not captured.",
        ]
      : [],
  };
};
