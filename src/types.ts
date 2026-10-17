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
