import {Context} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {
  GRAPH_NODE_NAME,
  GRAPH_NODE_TAG,
  TOOL_NAME,
  TOOL_TAG,
} from '../../constant';
import {IGraphNode, IGraphTool} from '../../types/tool';
import {
  MastraBridgeService,
  MastraRuntimeFactory,
} from '../../services/mastra-bridge.service';

describe('MastraBridgeService Unit', () => {
  it('collects tagged node and tool bindings during initialization', async () => {
    const context = new Context('mastra-bridge-context');

    const node: IGraphNode<AnyObject> = {
      execute: async () => ({}),
    };
    const tool: IGraphTool = {
      key: 'fake-tool',
      build: async () => {
        throw new Error('Not implemented for this unit test');
      },
    };

    context
      .bind('services.fake-node')
      .to(node)
      .tag({
        [GRAPH_NODE_TAG]: true,
        [GRAPH_NODE_NAME]: 'FakeNode',
      });

    context
      .bind('services.fake-tool')
      .to(tool)
      .tag({
        [TOOL_TAG]: true,
        [TOOL_NAME]: 'FakeTool',
      });

    const bridge = new MastraBridgeService(context);
    await bridge.initialize();

    const snapshot = bridge.getBootstrapSnapshot();

    expect(snapshot.nodes).to.have.length(1);
    expect(snapshot.nodes[0].key).to.equal('FakeNode');

    expect(snapshot.tools).to.have.length(1);
    expect(snapshot.tools[0].name).to.equal('FakeTool');

    const resolvedNode = await snapshot.nodes[0].resolve();
    const resolvedTool = await snapshot.tools[0].resolve();

    expect(resolvedNode).to.equal(node);
    expect(resolvedTool).to.equal(tool);
  });

  it('initializes the runtime adapter only once', async () => {
    const context = new Context('mastra-bridge-runtime-context');
    let callCount = 0;

    const adapter = {
      getAgent: <T>() => ({name: 'agent'}) as T,
      getWorkflow: <T>() => ({name: 'workflow'}) as T,
    };

    const runtimeFactory: MastraRuntimeFactory = async () => {
      callCount += 1;
      return adapter;
    };

    const bridge = new MastraBridgeService(context, runtimeFactory);

    await bridge.initialize();
    await bridge.initialize();

    expect(callCount).to.equal(1);
    expect(bridge.getTypedAgent<{name: string}>('chat-agent')?.name).to.equal(
      'agent',
    );
    expect(
      bridge.getTypedWorkflow<{name: string}>('db-workflow')?.name,
    ).to.equal('workflow');
  });
});
