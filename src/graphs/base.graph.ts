import {CompiledGraph} from '@langchain/langgraph';
import {Context, inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {GRAPH_NODE_NAME} from '../constant';
import {IGraphNode} from './types';

export abstract class BaseGraph<T extends object> {
  @inject.context()
  protected context: Context;

  abstract build(): Promise<CompiledGraph<AnyObject[string]>>;

  protected async _getNodeFn(key: string) {
    const bindings = this.context.findByTag({
      [GRAPH_NODE_NAME]: key,
    });
    if (bindings.length === 0) {
      throw new Error(`Node with key ${key} not found`);
    }
    if (bindings.length > 1) {
      throw new Error(`Multiple nodes found with key ${key}`);
    }
    const binding = bindings[0];
    const node = await this.context.get<IGraphNode<T>>(binding.key);
    return node.execute.bind(node);
  }
}
