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

export type LLMStreamEvent =
  | LLMStreamInitEvent
  | LLMStreamMessageEvent
  | LLMStreamStatusEvent
  | LLMStreamToolEvent
  | LLMStreamToolStatusEvent
  | LLMStreamLogEvent
  | LLMStreamTokenCountEvent;
