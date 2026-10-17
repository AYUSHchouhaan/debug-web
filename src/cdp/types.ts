export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
}

export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocket?: string;
}

export interface CdpDiscovery {
  readonly browser: string;
  readonly protocolVersion: string;
  readonly targets: readonly CdpTarget[];
}
