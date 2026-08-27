import {AnyObject} from '@loopback/repository';

export enum LLMStreamEventType {
  Message = 'message',
  Error = 'error',
  Tool = 'tool',
  Status = 'status',
  Log = 'log',
  Init = 'init',
  ToolStatus = 'tool-status',
  TokenCount = 'token-count',
}

export type LLMStreamToolEvent = {
  type: LLMStreamEventType.Tool;
  data: {
    id: string;
    tool: string;
    data: Record<string, AnyObject[string]>;
  };
};

export type LLMStreamToolStatusEvent = {
  type: LLMStreamEventType.ToolStatus;
  data: {
    id: string;
    status: string;
    data?: AnyObject;
  };
};

export type LLMStreamStatusEvent = {
  type: LLMStreamEventType.Status;
  data: string;
};

export type LLMStreamMessageEvent = {
  type: LLMStreamEventType.Message;
  data: {
    message: string;
  };
};

export type LLMStreamLogEvent = {
  type: LLMStreamEventType.Log;
  data: string;
};

export type LLMStreamTokenCountEvent = {
  type: LLMStreamEventType.TokenCount;
  data: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type LLMStreamInitEvent = {
  type: LLMStreamEventType.Init;
  data: {
    sessionId: string;
  };
};

/**
 * Catch-all event shape. The node stream previously flowed through LangGraph's
 * untyped custom writer, so nodes emit some events (e.g. `Error`, or a
 * `ToolStatus` without an `id`) that don't match a specific variant above. This
 * member keeps every `{type, data}` emission valid while preserving the typed
 * variants for consumers that narrow on `type`.
 */
export type LLMStreamCustomEvent = {
  type: LLMStreamEventType;
  data?: unknown;
};

export type LLMStreamEvent =
  | LLMStreamInitEvent
  | LLMStreamMessageEvent
  | LLMStreamStatusEvent
  | LLMStreamToolEvent
  | LLMStreamToolStatusEvent
  | LLMStreamLogEvent
  | LLMStreamTokenCountEvent
  | LLMStreamCustomEvent;
