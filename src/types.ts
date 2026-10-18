export interface DebugWebRequest {
  readonly request_id: string;
  readonly url: string;
  readonly method: string;
  readonly resource_type: string | null;
  readonly status: number | null;
  readonly mime_type: string | null;
  readonly duration_ms: number | null;
  readonly request_headers: Readonly<Record<string, string>>;
  readonly response_headers: Readonly<Record<string, string>>;
  readonly request_body: string | null;
  readonly response_body: string | null;
  readonly response_body_state: "not_requested" | "available" | "unavailable" | "over_limit";
  readonly initiator_url: string | null;
  readonly failure: string | null;
}

export interface DebugWebEvent {
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: number | null;
  readonly url: string | null;
  readonly request_id: string | null;
  readonly detail: string | null;
}

export interface DomNode {
  readonly index: number;
  readonly parent_index: number;
  readonly node_type: number;
  readonly node_name: string;
  readonly attribute_names: readonly string[];
  readonly attribute_values?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly text_length: number;
}

export interface DomSnapshotResult {
  readonly nodes: readonly DomNode[];
  readonly total_nodes: number;
  readonly truncated: boolean;
  readonly byte_length: number;
  readonly limitations: readonly string[];
}
