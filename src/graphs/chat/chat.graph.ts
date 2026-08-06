import {createWorkflow} from '@mastra/core/workflows';
import {BindingScope, inject, injectable} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {AiIntegrationBindings} from '../../keys';
import {TokenCounter} from '../../services/token-counter.service';
import {ToolStore} from '../../types';
import {BaseGraph} from '../base.graph';
import {passthroughSchema} from '../engine';
import {getToolCalls, ModelMessage} from '../messages';
import {ChatGraphAnnotation, ChatState} from '../state';
import {LLMCallbacks} from '../types';
import {ChatNodes} from './nodes.enum';

/** Safety cap mirroring the previous LangGraph `recursionLimit`. */
const MAX_TOOL_TURNS = 60;

@injectable({scope: BindingScope.REQUEST})
export class ChatGraph extends BaseGraph<ChatState> {
  protected stateSchema =
    ChatGraphAnnotation as unknown as z.ZodType<ChatState>;
  private _toolTurns = 0;

  constructor(
    @inject(AiIntegrationBindings.Tools)
    private readonly tools: ToolStore,
    @inject('services.TokenCounter')
    private readonly tokenCounter: TokenCounter,
    @inject(AiIntegrationBindings.ObfHandler, {optional: true})
    protected readonly obfHandler?: AnyObject[string],
  ) {
    super();
  }

  async execute(
    query: string,
    files: Express.Multer.File[] | Express.Multer.File,
    abort: AbortSignal,
    id?: string,
  ) {
    let fileArray: Express.Multer.File[] = [];
    if (Array.isArray(files)) {
      fileArray = files;
    } else if (files) {
      fileArray.push(files);
    } else {
      // do nothing if no files are provided
    }

    const inputs: ChatState = {
      id,
      messages: [],
      files: fileArray,
      prompt: query,
      userMessage: undefined,
      aiMessage: undefined,
    };

    const callbacks: LLMCallbacks[] = [
      {
        handleLLMStart: (runId, modelName) =>
          this.tokenCounter.handleLlmStart(runId, modelName),
        handleLLMEnd: (runId, result) =>
          this.tokenCounter.handleLlmEnd(runId, result),
      },
    ];
    if (this.obfHandler) {
      callbacks.push(this.obfHandler as LLMCallbacks);
    }

    return this.streamEvents(inputs, {
      signal: abort,
      callbacks,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      configurable: {thread_id: id},
    });
  }

  private _lastMessage(state: ChatState): ModelMessage | undefined {
    return state.messages.at(-1);
  }

  private _hasToolCalls(state: ChatState): boolean {
    const last = this._lastMessage(state);
    return last ? getToolCalls(last).length > 0 : false;
  }

  private _firstToolNeedsReview(state: ChatState): boolean {
    const last = this._lastMessage(state);
    const name = last ? getToolCalls(last)[0]?.toolName : undefined;
    return name ? this.tools.map[name]?.needsReview !== false : false;
  }

  private _lastIsToolResult(state: ChatState): boolean {
    return this._lastMessage(state)?.role === 'tool';
  }

  build() {
    this._toolTurns = 0;
    const initSession = this._toStep(ChatNodes.InitSession);
    const summariseFile = this._toStep(ChatNodes.SummariseFile);
    const callLlm = this._toStep(ChatNodes.CallLLM);
    const runTool = this._toStep(ChatNodes.RunTool);
    const trimMessages = this._toStep(ChatNodes.TrimMessages);
    const endSession = this._toStep(ChatNodes.EndSession);
    const noop = this._toFnStep('chat_no_tool', () => ({}));
    const reviewGuard = this._toFnStep('chat_review_guard', state => {
      const last = this._lastMessage(state);
      const calls = last ? getToolCalls(last) : [];
      throw new Error(
        `Tool ${calls[0]?.toolName} requires user review which is not implemented yet.`,
      );
    });

    // RunTool → TrimMessages, run as a nested workflow so it can be a branch target.
    const runToolThenTrim = createWorkflow({
      id: 'chat_run_tool_then_trim',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(runTool)
      .then(trimMessages)
      .commit();

    // One tool turn: call the LLM, then either run the requested tool or finish.
    const toolTurn = createWorkflow({
      id: 'chat_tool_turn',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(callLlm)
      .branch([
        [
          async ({state}) =>
            this._hasToolCalls(state as ChatState) &&
            this._firstToolNeedsReview(state as ChatState),
          reviewGuard,
        ],
        [
          async ({state}) =>
            this._hasToolCalls(state as ChatState) &&
            !this._firstToolNeedsReview(state as ChatState),
          runToolThenTrim,
        ],
        [async ({state}) => !this._hasToolCalls(state as ChatState), noop],
      ])
      .commit();

    return (
      createWorkflow({
        id: 'chat_graph',
        inputSchema: passthroughSchema,
        outputSchema: passthroughSchema,
        stateSchema: this.stateSchema,
      })
        .then(initSession)
        // Summarise files one at a time until none remain (also handles the
        // no-file case by running once).
        .dowhile(summariseFile, async ({state}) => {
          const s = state as ChatState;
          return !!(s.files && s.files.length > 0);
        })
        // Tool loop: keep calling the LLM while the previous turn ran a tool
        // (i.e. the last message is a tool result), capped for safety.
        .dowhile(
          toolTurn,
          async ({state}) =>
            this._lastIsToolResult(state as ChatState) &&
            ++this._toolTurns < MAX_TOOL_TURNS,
        )
        .then(endSession)
        .commit()
    );
  }
}
