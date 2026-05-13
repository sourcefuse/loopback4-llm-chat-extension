import {createWorkflow} from '@mastra/core/workflows';
import {
  ChatWorkflowInputSchema,
  ChatWorkflowOutputSchema,
} from './chat-workflow-schemas';
import {initSessionStep} from './steps/init-session.step';
import {prepareContextStep} from './steps/prepare-context.step';
import {fileProcessingStep} from './steps/file-processing.step';
import {agentReasoningStep} from './steps/agent-reasoning.step';
import {persistConversationStep} from './steps/persist-conversation.step';
import {endSessionStep} from './steps/end-session.step';

/**
 * ChatWorkflow — Mastra replacement for the LangGraph ChatGraph.
 *
 * Step pipeline:
 *  initSession → prepareContext → fileProcessing → agentReasoning → persistConversation → endSession
 *
 * All SSE events are routed through the AsyncEventQueue stored in RequestContext.
 * Token usage is accumulated in TokenUsageAccumulator stored in RequestContext.
 *
 * The workflow does NOT directly interact with the SSE transport — that is the
 * responsibility of WorkflowRunner, which runs the workflow concurrently with
 * the event forwarding loop.
 *
 * RequestContext keys (injected by WorkflowRunner):
 *  - chatStore: ChatStore (REQUEST-scoped)
 *  - eventQueue: AsyncEventQueue (per-request)
 *  - tokenUsageAccumulator: TokenUsageAccumulator (per-request)
 *  - mastraChatLlm: MastraLanguageModel (bound in LB4 DI)
 *  - mastraFileLlm: MastraLanguageModel (optional, bound in LB4 DI)
 *  - toolStore: ToolStore (REQUEST-scoped via ToolsProvider)
 *  - aiConfig: { maxTokens?, maxSteps?, modelName? } (optional, from LB4 config)
 *  - systemContext: string[] (optional, from LB4 SystemContext binding)
 *  - abortSignal: AbortSignal (from AbortController in GenerationService)
 */
export const chatWorkflow = createWorkflow({
  id: 'chat-workflow',
  inputSchema: ChatWorkflowInputSchema,
  outputSchema: ChatWorkflowOutputSchema,
})
  .then(initSessionStep)
  .then(prepareContextStep)
  .then(fileProcessingStep)
  .then(agentReasoningStep)
  .then(persistConversationStep)
  .then(endSessionStep)
  .commit();
