import {createStep} from '@mastra/core/workflows';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
import {
  AgentReasoningOutputSchema,
  PersistConversationOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')(
  'ai-integration:mastra:persist-conversation.step',
);

/**
 * PersistConversationStep — save the AI response and tool results to the database.
 *
 * LangGraph equivalent: the persistence part of `CallLLMNode` + `RunToolNode`.
 *
 * Responsibilities:
 *  - Persist the AI's final text response as an AI-type message
 *  - For each tool call, persist a Tool-type message linked to the AI message
 *  - Retrieve per-tool metadata (e.g. report IDs) via IGraphTool.getMetadata()
 *
 * Tool message metadata enrichment:
 *  `IGraphTool.getMetadata(rawResult)` returns application-specific metadata
 *  (e.g. `{ reportId: '...' }`) that gets stored alongside the tool message.
 *  `IGraphTool.getValue(rawResult)` returns the human-readable content to store.
 */
export const persistConversationStep = createStep({
  id: 'persist-conversation',
  description: 'Persist AI response and tool call results to the database',
  inputSchema: AgentReasoningOutputSchema,
  outputSchema: PersistConversationOutputSchema,
  execute: async ({inputData, requestContext}) => {
    const ctx = asWorkflowContext(requestContext);
    const chatStore = ctx.get('chatStore');
    const toolStore = ctx.get('toolStore');

    const {
      sessionId,
      finalText,
      toolCalls,
      totalInputTokens,
      totalOutputTokens,
      tokenMap,
    } = inputData;

    debug(
      `PersistConversation: session=${sessionId}, textLen=${finalText.length}, tools=${toolCalls.length}`,
    );

    // 1. Persist the AI's text response
    const aiMessage = await chatStore.addAIMessageText(sessionId, finalText);

    if (!aiMessage) {
      debug('PersistConversation: addAIMessageText returned undefined');
    }

    // 2. Persist each tool call as a linked Tool message
    for (const toolCall of toolCalls) {
      const igraphTool = toolStore?.map?.[toolCall.toolName];

      const content =
        igraphTool?.getValue?.(toolCall.rawResult as Record<string, string>) ??
        JSON.stringify(toolCall.rawResult);

      const metadata =
        igraphTool?.getMetadata?.(
          toolCall.rawResult as Record<string, string>,
        ) ?? {};

      if (aiMessage) {
        await chatStore.addToolMessageText(
          sessionId,
          toolCall.toolCallId,
          toolCall.toolName,
          content,
          metadata,
          aiMessage,
          toolCall.args,
        );
      }
    }

    debug(
      `PersistConversation: saved AI message (${toolCalls.length} tool messages)`,
    );

    return {sessionId, totalInputTokens, totalOutputTokens, tokenMap};
  },
});
