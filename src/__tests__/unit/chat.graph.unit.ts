import {Context} from '@loopback/core';
import {expect} from '@loopback/testlab';
import {GRAPH_NODE_NAME} from '../../constant';
import {ChatGraph, ChatNodes, ChatState, IGraphTool} from '../../graphs';
import {AiIntegrationBindings} from '../../keys';
import {TokenCounter} from '../../services';
import {buildFileStub, buildNodeStub} from '../test-helper';

/**
 * `graph.execute` now returns an event queue and runs the Mastra workflow in
 * the background, closing the queue when the run finishes. Draining the queue
 * therefore waits for the workflow to run to completion — the behavioural
 * replacement for `await`-ing the old compiled LangGraph invocation.
 */
async function runGraph(
  graph: ChatGraph,
  query: string,
  files: Express.Multer.File[] | Express.Multer.File,
) {
  const queue = await graph.execute(query, files, new AbortController().signal);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const event of queue) {
    // Ignore emitted events; we only need the run to finish.
  }
}

describe(`ChatGraph Unit`, function () {
  let graph: ChatGraph;
  let stubMap: Record<ChatNodes, sinon.SinonStub>;

  beforeEach(async () => {
    const context = new Context('test-context');
    context.bind(AiIntegrationBindings.Tools).to({
      list: [],
      map: {
        'test-tool': {
          needsReview: false,
          key: 'test-tool',
          build: (async () => {}) as unknown as IGraphTool['build'],
        },
      },
    });
    context.bind('services.TokenCounter').to(new TokenCounter());
    context.bind('ChatGraph').toClass(ChatGraph);
    stubMap = {} as Record<ChatNodes, sinon.SinonStub>;
    for (const key of Object.values(ChatNodes)) {
      const stub = buildNodeStub();
      context
        .bind(`services.${key}`)
        .to(stub)
        .tag({
          [GRAPH_NODE_NAME]: key,
        });
      stubMap[key] = stub.execute;
    }
    graph = await context.get<ChatGraph>('ChatGraph');
  });

  it('should init session, and end session on user prompt', async () => {
    await runGraph(graph, 'test prompt', []);

    expect(stubMap[ChatNodes.InitSession].calledOnce).to.be.true();
    expect(stubMap[ChatNodes.CallLLM].calledOnce).to.be.true();
    // should end at this point
    expect(stubMap[ChatNodes.TrimMessages].calledOnce).to.be.false();
    // called once by default
    expect(stubMap[ChatNodes.SummariseFile].calledOnce).to.be.true();
    // should be called after call LLM
    expect(stubMap[ChatNodes.EndSession].calledOnce).to.be.true();
  });

  it('should init session, summarise multiple files, and end session on user prompt if no tool call', async () => {
    stubMap[ChatNodes.SummariseFile].callsFake((state: ChatState) => {
      return {
        ...state,
        files: state.files?.filter(
          (f: Express.Multer.File, index: number) => index !== 0,
        ),
      };
    });

    await runGraph(graph, 'test prompt', [buildFileStub(), buildFileStub()]);

    expect(stubMap[ChatNodes.InitSession].calledOnce).to.be.true();
    expect(stubMap[ChatNodes.CallLLM].calledOnce).to.be.true();
    // should end at this point
    expect(stubMap[ChatNodes.TrimMessages].calledOnce).to.be.false();
    // called once by default
    expect(stubMap[ChatNodes.SummariseFile].getCalls().length).to.be.equal(2);
    // should be called after call LLM
    expect(stubMap[ChatNodes.EndSession].calledOnce).to.be.true();
  });

  it('should init session, summarise single files, and end session on user prompt if no tool call', async () => {
    stubMap[ChatNodes.SummariseFile].callsFake((state: ChatState) => {
      return {
        ...state,
        files: state.files?.filter(
          (f: Express.Multer.File, index: number) => index !== 0,
        ),
      };
    });

    await runGraph(graph, 'test prompt', buildFileStub());

    expect(stubMap[ChatNodes.InitSession].calledOnce).to.be.true();
    expect(stubMap[ChatNodes.CallLLM].calledOnce).to.be.true();
    // should end at this point
    expect(stubMap[ChatNodes.TrimMessages].calledOnce).to.be.false();
    // called once by default
    expect(stubMap[ChatNodes.SummariseFile].getCalls().length).to.be.equal(1);
    // should be called after call LLM
    expect(stubMap[ChatNodes.EndSession].calledOnce).to.be.true();
  });

  it('should init session, summarise file, call LLM, run tool and end session', async () => {
    let calledAlready = false;
    stubMap[ChatNodes.CallLLM].callsFake((state: ChatState) => {
      if (calledAlready) {
        // if called already, return the LLM response without tool call
        return {
          ...state,
          messages: [
            ...state.messages,
            {role: 'assistant', content: 'This is a response from LLM'},
          ],
        };
      }
      calledAlready = true;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            role: 'assistant',
            content: [
              {type: 'text', text: 'This is a response from LLM'},
              {
                type: 'tool-call',
                toolCallId: 'tool-call-1',
                toolName: 'test-tool',
                input: {},
              },
            ],
          },
        ],
      };
    });

    // The tool loop continues only while the last message is a tool result, so
    // the RunTool node must append one. The generic node stub returns the state
    // unchanged, which would end the loop after a single LLM call; here we make
    // it emit the tool message the real node would produce.
    stubMap[ChatNodes.RunTool].callsFake((state: ChatState) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tool-call-1',
              toolName: 'test-tool',
              output: {type: 'text', value: 'tool result'},
            },
          ],
        },
      ],
    }));

    await runGraph(graph, 'test prompt', []);

    expect(stubMap[ChatNodes.InitSession].calledOnce).to.be.true();
    // this should called twice
    expect(stubMap[ChatNodes.CallLLM].calledTwice).to.be.true();
    // should call the tool once
    expect(stubMap[ChatNodes.RunTool].calledOnce).to.be.true();
    // should call this once after the tool call
    expect(stubMap[ChatNodes.TrimMessages].calledOnce).to.be.true();
    // called once by default
    expect(stubMap[ChatNodes.SummariseFile].calledOnce).to.be.true();
    // should be called after call LLM
    expect(stubMap[ChatNodes.EndSession].calledOnce).to.be.true();
  });
});
