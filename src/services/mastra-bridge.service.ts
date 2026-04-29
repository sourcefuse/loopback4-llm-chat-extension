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
  /**
   * Human-readable description stored in the binding tag by `@graphTool({ description })`.
   * Available at startup without resolving the tool instance.
   */
  description?: string;
  /**
   * Zod input schema stored in the binding tag by `@graphTool({ inputSchema })`.
   * Available at startup without resolving the tool instance.
   */
  inputSchema?: unknown;
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
 *
 * Returns `unknown` intentionally so that host-app factory implementations can
 * return concrete agent / workflow types without a generic mismatch.  Callers
 * should cast the return value to the expected interface at the call site.
 */
export interface MastraRuntimeAdapter {
  getAgent(name: string): unknown;
  getWorkflow(name: string): unknown;
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
  /**
   * Returns the underlying runtime adapter.  Use this when you need to access
   * the adapter beyond the typed `getTypedAgent` / `getTypedWorkflow` shortcuts.
   */
  getRuntime(): MastraRuntimeAdapter;
  /** Returns the raw (untyped) agent instance registered under the given name. */
  getAgent(name: string): unknown;
  /** Returns the raw (untyped) workflow instance registered under the given name. */
  getWorkflow(name: string): unknown;
  /**
   * Type-safe accessor for a registered agent.  The cast is performed internally;
   * callers receive `T | undefined` without any explicit cast at the call site.
   */
  getTypedAgent<T>(name: string): T | undefined;
  /**
   * Type-safe accessor for a registered workflow.  The cast is performed internally;
   * callers receive `T | undefined` without any explicit cast at the call site.
   */
  getTypedWorkflow<T>(name: string): T | undefined;
  getBootstrapSnapshot(): MastraBootstrapPayload;
}

/**
 * Default no-op runtime adapter used until a real Mastra runtime is bound.
 */
class NoopMastraRuntimeAdapter implements MastraRuntimeAdapter {
  /**
   * Returns undefined for all agents in no-op mode.
   */
  getAgent(_name: string): unknown {
    return undefined;
  }

  /**
   * Returns undefined for all workflows in no-op mode.
   */
  getWorkflow(_name: string): unknown {
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
    try {
      this.runtime = await (this.runtimeFactory
        ? this.runtimeFactory(this.payload)
        : new NoopMastraRuntimeAdapter());
      this.initialized = true;
    } catch (error) {
      throw new Error(`Mastra runtime initialization failed: ${error}`);
    }
  }

  /**
   * Returns the underlying runtime adapter.
   */
  getRuntime(): MastraRuntimeAdapter {
    if (!this.initialized) {
      throw new Error('MastraBridgeService not initialized');
    }
    return this.runtime;
  }

  /**
   * Returns the raw (untyped) agent instance registered under the given name.
   */
  getAgent(name: string): unknown {
    return this.getRuntime().getAgent(name);
  }

  /**
   * Returns the raw (untyped) workflow instance registered under the given name.
   */
  getWorkflow(name: string): unknown {
    return this.getRuntime().getWorkflow(name);
  }

  /**
   * Type-safe accessor: retrieves the agent and narrows it to `T`.
   * The single internal cast is contained here so call sites remain cast-free.
   */
  getTypedAgent<T>(name: string): T | undefined {
    return this.getRuntime().getAgent(name) as T | undefined;
  }

  /**
   * Type-safe accessor: retrieves the workflow and narrows it to `T`.
   * The single internal cast is contained here so call sites remain cast-free.
   */
  getTypedWorkflow<T>(name: string): T | undefined {
    return this.getRuntime().getWorkflow(name) as T | undefined;
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
      description: binding.tagMap?.['toolDescription'] as string | undefined,
      inputSchema: binding.tagMap?.['toolInputSchema'],
      resolve: async () => this.context.get<IGraphTool>(binding.key),
    }));

    return {nodes, tools};
  }
}
