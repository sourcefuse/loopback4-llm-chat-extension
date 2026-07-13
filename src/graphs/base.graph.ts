import {Context, inject} from '@loopback/core';
import {GRAPH_NODE_NAME} from '../constant';
import type {IGraphNode} from './types';

/**
 * Resolve a `@graphNode(key)`-tagged class instance from an LB4 container.
 * Faithful port of the LangGraph `BaseGraph._getNodeFn` tag lookup: exactly one
 * binding must carry the key. A host overrides a bundled node by rebinding the
 * same key (replacing the library's node); zero or more-than-one bindings is an
 * error. Extracted as a free function so the same resolver backs both
 * {@link BaseGraph._getNodeFn} (chat graph) and the per-request `resolveNode`
 * closure the db-query / visualization workflow shells read from RequestContext.
 */
export async function resolveNodeFromContext(
  context: Context,
  key: string,
): Promise<IGraphNode> {
  const bindings = context.findByTag({[GRAPH_NODE_NAME]: key});
  if (bindings.length === 0) {
    throw new Error(
      `Node with key "${key}" not found. Bind a @graphNode('${key}') class ` +
        `as a service (the bundled components register the defaults).`,
    );
  }
  if (bindings.length > 1) {
    throw new Error(`Multiple nodes found with key "${key}"`);
  }
  return context.get<IGraphNode>(bindings[0].key);
}

/**
 * Base class for the extension's graphs (the LangGraph `BaseGraph`). Owns the
 * request-scoped LB4 `context` and the {@link _getNodeFn} node resolver so a
 * concrete graph (e.g. {@link ChatGraph}) resolves each of its `@graphNode`
 * classes by tag and a host can override any one by rebinding it.
 *
 * Unlike the LangGraph original there is no abstract `build()` returning a
 * compiled `StateGraph`: Mastra's chat runs on a streaming `Agent`, so
 * {@link ChatGraph} orchestrates its nodes imperatively rather than compiling a
 * DAG. The node-resolution + override seam is identical.
 */
export abstract class BaseGraph {
  @inject.context()
  protected context: Context;

  protected _getNodeFn(key: string): Promise<IGraphNode> {
    return resolveNodeFromContext(this.context, key);
  }
}
