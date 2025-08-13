import {AIMessage} from '@langchain/core/messages';
import {END, START, StateGraph} from '@langchain/langgraph';
import {BindingScope, inject, injectable} from '@loopback/core';
import {AiIntegrationBindings} from '../../keys';
import {TokenCounter} from '../../services/token-counter.service';
import {ToolStore} from '../../types';
import {BaseGraph} from '../base.graph';
import {ChatGraphAnnotation, ChatState} from '../state';
import {ChatNodes} from './nodes.enum';

@injectable({scope: BindingScope.REQUEST})
export class ChatGraph extends BaseGraph<ChatState> {
  constructor(
    @inject(AiIntegrationBindings.Tools)
    private readonly tools: ToolStore,
    @inject('services.TokenCounter')
    private readonly tokenCounter: TokenCounter,
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
    const graph = await this.build();

    const inputs: ChatState = {
      id,
      messages: [],
      files: fileArray,
      prompt: query,
      userMessage: undefined,
      aiMessage: undefined,
    };

    return graph.stream(inputs, {
      streamMode: 'custom' as const,
      recursionLimit: 60,
      configurable: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        thread_id: id,
      },
      signal: abort,
      callbacks: [
        {
          handleLLMEnd: this.tokenCounter.handleLlmEnd.bind(this.tokenCounter),
        },
      ],
    });
  }
  async build() {
    const graph = new StateGraph(ChatGraphAnnotation);
    const toolsMap = this.tools.map;
    // add nodes
    graph
      .addNode(
        ChatNodes.TrimMessages,
        await this._getNodeFn(ChatNodes.TrimMessages),
      )
      .addNode(ChatNodes.CallLLM, await this._getNodeFn(ChatNodes.CallLLM))
      .addNode(ChatNodes.RunTool, await this._getNodeFn(ChatNodes.RunTool))
      .addNode(
        ChatNodes.SummariseFile,
        await this._getNodeFn(ChatNodes.SummariseFile),
      )
      .addNode(
        ChatNodes.InitSession,
        await this._getNodeFn(ChatNodes.InitSession),
      )
      .addNode(
        ChatNodes.EndSession,
        await this._getNodeFn(ChatNodes.EndSession),
      )
      // add edges
      .addEdge(START, ChatNodes.InitSession)
      .addEdge(ChatNodes.InitSession, ChatNodes.SummariseFile)
      .addConditionalEdges(
        ChatNodes.SummariseFile,
        (state: ChatState) => {
          if (state.files && state.files.length > 0) {
            return ChatNodes.SummariseFile;
          }
          return ChatNodes.CallLLM;
        },
        [ChatNodes.SummariseFile, ChatNodes.CallLLM],
      )
      .addConditionalEdges(
        ChatNodes.CallLLM,
        (state: ChatState) => {
          const lastMessage = state.messages[
            state.messages.length - 1
          ] as AIMessage;
          if (!lastMessage?.tool_calls?.length) {
            return ChatNodes.EndSession;
          }
          if (toolsMap[lastMessage?.tool_calls[0].name].needsReview === false) {
            return ChatNodes.RunTool;
          } else {
            throw new Error(
              `Tool ${lastMessage.tool_calls[0].name} requires user review which is not implemented yet.`,
            );
          }
        },
        [ChatNodes.RunTool, ChatNodes.EndSession],
      )
      .addEdge(ChatNodes.RunTool, ChatNodes.TrimMessages)
      .addEdge(ChatNodes.TrimMessages, ChatNodes.CallLLM)
      .addEdge(ChatNodes.EndSession, END);

    const compiled = graph.compile({});

    return compiled;
  }
}
