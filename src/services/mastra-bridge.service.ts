import {
  GRAPH_NODE_NAME,
  GRAPH_NODE_TAG,
  TOOL_NAME,
  TOOL_TAG,
} from '../constant';
import {IGraphNode, IGraphTool} from '../graphs/types';
import {AiIntegrationBindings} from '../keys';
import {AnyObject} from '@loopback/repository';
import {Context, inject, injectable, BindingScope} from '@loopback/core';

/**
 * Lazy resolver for LoopBack-managed instances.
 */
export type BindingResolver<T> = () => Promise<T>;

/**
 * Descriptor for a graph node registered in LoopBack's IoC container.
 */
export interface GraphNodeBindingDescriptor {
  bindingKey: string;
  key: string;
  resolve: BindingResolver<IGraphNode<AnyObject>>;
}

/**
 * Descriptor for a graph tool registered in LoopBack's IoC container.
 */
export interface GraphToolBindingDescriptor {
  bindingKey: string;
  key: string;
  name: string;
  resolve: BindingResolver<IGraphTool>;
}

/**
 * Payload used to initialize a Mastra runtime instance from LoopBack bindings.
 */
export interface MastraBootstrapPayload {
  nodes: GraphNodeBindingDescriptor[];
  tools: GraphToolBindingDescriptor[];
}

/**
 * Minimal runtime contract required by the migration bridge.
 */
export interface MastraRuntimeAdapter {
  getAgent<T>(name: string): T | undefined;
  getWorkflow<T>(name: string): T | undefined;
}

/**
 * Factory contract for creating a runtime adapter from LoopBack-registered artifacts.
 */
export type MastraRuntimeFactory = (
  payload: MastraBootstrapPayload,
) => Promise<MastraRuntimeAdapter> | MastraRuntimeAdapter;

/**
 * Public bridge contract exposed through LoopBack bindings.
 */
export interface IMastraBridge {
  initialize(): Promise<void>;
  getAgent<T>(name: string): T | undefined;
  getWorkflow<T>(name: string): T | undefined;
  getBootstrapSnapshot(): MastraBootstrapPayload;
}

/**
 * Default no-op runtime adapter used until a real Mastra runtime is bound.
 */
class NoopMastraRuntimeAdapter implements MastraRuntimeAdapter {
  /**
   * Returns undefined for all agents in no-op mode.
   */
  getAgent<T>(_name: string): T | undefined {
    return undefined;
  }

  /**
   * Returns undefined for all workflows in no-op mode.
   */
  getWorkflow<T>(_name: string): T | undefined {
    return undefined;
  }
}

/**
 * Phase 0 migration bridge that discovers LoopBack graph artifacts and creates
 * a Mastra runtime adapter without changing current LangGraph behavior.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraBridgeService implements IMastraBridge {
  private runtime: MastraRuntimeAdapter = new NoopMastraRuntimeAdapter();
  private payload: MastraBootstrapPayload = {nodes: [], tools: []};
  private initialized = false;

  constructor(
    @inject.context()
    private readonly context: Context,
    @inject(AiIntegrationBindings.MastraRuntimeFactory, {optional: true})
    private readonly runtimeFactory?: MastraRuntimeFactory,
  ) {}

  /**
   * Initializes the bridge once by collecting tagged bindings and creating the runtime adapter.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.payload = this.collectBootstrapPayload();
    this.runtime = this.runtimeFactory
      ? await this.runtimeFactory(this.payload)
      : new NoopMastraRuntimeAdapter();
    this.initialized = true;
  }

  /**
   * Returns a typed agent instance from the runtime adapter.
   */
  getAgent<T>(name: string): T | undefined {
    return this.runtime.getAgent<T>(name);
  }

  /**
   * Returns a typed workflow instance from the runtime adapter.
   */
  getWorkflow<T>(name: string): T | undefined {
    return this.runtime.getWorkflow<T>(name);
  }

  /**
   * Returns a snapshot of discovered LoopBack artifacts registered for runtime bootstrap.
   */
  getBootstrapSnapshot(): MastraBootstrapPayload {
    return this.payload;
  }

  /**
   * Discovers all node and tool bindings and exposes lazy resolvers for runtime construction.
   */
  private collectBootstrapPayload(): MastraBootstrapPayload {
    const nodeBindings = this.context.findByTag({
      [GRAPH_NODE_TAG]: true,
    });
    const toolBindings = this.context.findByTag({
      [TOOL_TAG]: true,
    });

    const nodes: GraphNodeBindingDescriptor[] = nodeBindings.map(binding => ({
      bindingKey: binding.key,
      key: String(binding.tagMap?.[GRAPH_NODE_NAME] ?? binding.key),
      resolve: async () => this.context.get<IGraphNode<AnyObject>>(binding.key),
    }));

    const tools: GraphToolBindingDescriptor[] = toolBindings.map(binding => ({
      bindingKey: binding.key,
      key: String(binding.key),
      name: String(binding.tagMap?.[TOOL_NAME] ?? binding.key),
      resolve: async () => this.context.get<IGraphTool>(binding.key),
    }));

    return {nodes, tools};
  }
}
