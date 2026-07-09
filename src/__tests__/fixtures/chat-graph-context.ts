import {
  BindingScope,
  Constructor,
  Context,
  CoreTags,
  createBindingFromClass,
} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {AiIntegrationBindings} from '../../keys';
import {UsageAccumulator} from '../../services/usage-accumulator.service';
import {ChatLedgerService} from '../../services/chat-ledger.service';
import {RequestContextBuilder} from '../../runtime/request-context.builder';
import {
  CallLLMNode,
  ChatGraph,
  ChatStore,
  ContextCompressionNode,
  EndSessionNode,
  InitSessionNode,
  RunToolNode,
  SummariseFileNode,
} from '../../graphs/chat';

/**
 * Build a CONTAINER-backed {@link ChatGraph} for chat tests, mirroring
 * production wiring (component.ts registers ChatGraph + ChatStore + the 6
 * `@graphNode` classes as tagged services, resolved via BaseGraph._getNodeFn).
 *
 * The chat nodes are DI classes whose collaborators are constructor-injected,
 * so a test binds the stub collaborators into a real LB4 Context and resolves
 * ChatGraph from it — never `new ChatGraph()`. This is exactly how a host
 * overrides a node (rebind its `@graphNode(key)` class), so the tests exercise
 * the real override seam. Everything is optional; a node that doesn't use a
 * given collaborator just gets `undefined`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stub = any;
export interface ChatGraphDeps {
  mastra: Stub;
  usage?: UsageAccumulator;
  authUser?: Stub | null;
  resourceId?: string;
  chatLlm?: Stub;
  fileLlm?: Stub;
  cheapLlm?: Stub;
  smartLlm?: Stub;
  smartNonThinkingLlm?: Stub;
  tools?: Stub;
  systemContext?: string[];
  fileMessageBuilder?: Stub;
  chatLedger?: Stub;
}

const CHAT_NODE_CLASSES = [
  InitSessionNode,
  SummariseFileNode,
  CallLLMNode,
  RunToolNode,
  ContextCompressionNode,
  EndSessionNode,
];

export function makeChatGraph(deps: ChatGraphDeps): {
  ctx: Context;
  chatGraph: ChatGraph;
} {
  const ctx = new Context('test-chat');

  // Register the graph + store + nodes as tagged services (TRANSIENT so the
  // test resolves them without a live request scope). The `@graphNode` tag on
  // each node class is what BaseGraph._getNodeFn looks up.
  const chatGraphBinding = createBindingFromClass(ChatGraph, {
    defaultScope: BindingScope.TRANSIENT,
  });
  ctx.add(chatGraphBinding);
  // `@service(ChatStore)` / `@service(RequestContextBuilder)` (used by the
  // nodes) resolve via SERVICE_INTERFACE, which `app.service()` sets in
  // production but createBindingFromClass does not — tag them explicitly (see
  // step-resolver.ts).
  ctx.add(
    createBindingFromClass(ChatStore, {
      defaultScope: BindingScope.TRANSIENT,
    }).tag({[CoreTags.SERVICE_INTERFACE]: ChatStore}),
  );
  ctx.add(
    createBindingFromClass(RequestContextBuilder, {
      defaultScope: BindingScope.TRANSIENT,
    }).tag({[CoreTags.SERVICE_INTERFACE]: RequestContextBuilder}),
  );
  const nodeClasses: Array<Constructor<object>> = [...CHAT_NODE_CLASSES];
  for (const cls of nodeClasses) {
    ctx.add(
      createBindingFromClass(cls, {defaultScope: BindingScope.TRANSIENT}),
    );
  }

  ctx.bind(AiIntegrationBindings.Mastra.key).to(deps.mastra as never);

  const bindIf = (key: string, value: unknown) => {
    if (value !== undefined) ctx.bind(key).to(value as never);
  };
  bindIf(AiIntegrationBindings.ChatLLM.key, deps.chatLlm);
  bindIf(AiIntegrationBindings.FileLLM.key, deps.fileLlm);
  bindIf(AiIntegrationBindings.CheapLLM.key, deps.cheapLlm);
  bindIf(AiIntegrationBindings.SmartLLM.key, deps.smartLlm);
  bindIf(
    AiIntegrationBindings.SmartNonThinkingLLM.key,
    deps.smartNonThinkingLlm,
  );
  bindIf(AiIntegrationBindings.Tools.key, deps.tools);
  bindIf(AiIntegrationBindings.SystemContext.key, deps.systemContext);
  bindIf(AiIntegrationBindings.FileMessageBuilder.key, deps.fileMessageBuilder);
  bindIf(AiIntegrationBindings.ResourceId.key, deps.resourceId);
  if (deps.authUser) {
    ctx.bind(AuthenticationBindings.CURRENT_USER).to(deps.authUser as never);
  }
  // `@service(UsageAccumulator)` / `@service(ChatLedgerService)` resolve via a
  // ContextView filtered by class — NOT by binding key — so a value binding
  // must carry the serviceInterface tag to be found (see step-resolver.ts).
  if (deps.usage) {
    ctx
      .bind('services.UsageAccumulator')
      .to(deps.usage)
      .tag({[CoreTags.SERVICE_INTERFACE]: UsageAccumulator});
  }
  if (deps.chatLedger) {
    ctx
      .bind('services.ChatLedgerService')
      .to(deps.chatLedger as never)
      .tag({[CoreTags.SERVICE_INTERFACE]: ChatLedgerService});
  }

  const chatGraph = ctx.getSync<ChatGraph>(chatGraphBinding.key);
  return {ctx, chatGraph};
}
