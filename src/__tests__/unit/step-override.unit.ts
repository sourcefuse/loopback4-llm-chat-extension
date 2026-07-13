import {expect} from '@loopback/testlab';
import {Binding, Context, createBindingFromClass} from '@loopback/core';
import {GRAPH_NODE_NAME} from '../../constant';
import {graphNode} from '../../decorators';
import {GetTablesNode} from '../../components/db-query/nodes/get-tables.node';
import type {IGraphNode, GraphNodeCtx} from '../../graphs/types';

/**
 * Locks in the host-override contract for DI-backed workflow nodes, matching the
 * LangGraph BaseGraph._getNodeFn: a `@graphNode(key)` class is discovered by
 * tag, exactly one binding must carry the key, and a host overrides a bundled
 * node by REBINDING the same key (registering only its own class for that key).
 * Two bindings for the same key is ambiguous and throws — proven here at the
 * Context level without an app boot.
 */

// A consumer's replacement for the bundled `get_tables` node.
@graphNode('get_tables')
class HostGetTablesNode implements IGraphNode {
  async execute() {
    return {tables: ['host_override']};
  }
}

// Same resolution rule as WorkflowRunner.resolveGraphNode.
async function resolveNode(ctx: Context, key: string): Promise<IGraphNode> {
  const bindings = ctx.findByTag({[GRAPH_NODE_NAME]: key}) as Binding[];
  if (bindings.length === 0)
    throw new Error(`Node with key "${key}" not found`);
  if (bindings.length > 1)
    throw new Error(`Multiple nodes found with key "${key}"`);
  return ctx.get<IGraphNode>(bindings[0].key);
}

const emptyCtx = {
  inputData: {},
  requestContext: {get: () => undefined},
  getStepResult: () => undefined,
} as unknown as GraphNodeCtx;

describe('workflow node resolution + override (DI)', () => {
  it('resolves the single bundled node bound for a key', async () => {
    const ctx = new Context('test-default');
    ctx.add(createBindingFromClass(GetTablesNode));

    const resolved = await resolveNode(ctx, 'get_tables');
    // No SchemaStore bound → fail-soft empty set, the bundled behaviour.
    expect(await resolved.execute(emptyCtx)).to.eql({tables: []});
  });

  it('resolves the host node when it is the only one bound for the key (override = replace)', async () => {
    const ctx = new Context('test-override');
    // The consumer rebinds the key with its own class instead of the bundled one.
    ctx.add(createBindingFromClass(HostGetTablesNode));

    const resolved = await resolveNode(ctx, 'get_tables');
    expect(await resolved.execute(emptyCtx)).to.eql({
      tables: ['host_override'],
    });
  });

  it('throws when two classes are bound for the same key (ambiguous)', async () => {
    const ctx = new Context('test-ambiguous');
    ctx.add(createBindingFromClass(GetTablesNode));
    ctx.add(createBindingFromClass(HostGetTablesNode));

    await expect(resolveNode(ctx, 'get_tables')).to.be.rejectedWith(
      /Multiple nodes found with key "get_tables"/,
    );
  });
});
