import {createStep} from '@mastra/core/workflows';
import {
  AgentReasoningOutputSchema,
  PersistConversationOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')(
  'ai-integration:mastra:persist-conversation.step',
);

/**
 * PersistConversationStep — preserve workflow shape for token accounting.
 *
 * Conversation persistence now happens inside Mastra Memory via
 * `agent.stream({ memory: { thread, resource } })`.
 */
export const persistConversationStep = createStep({
  id: 'persist-conversation',
  description: 'Pass through token totals after memory-managed persistence',
  inputSchema: AgentReasoningOutputSchema,
  outputSchema: PersistConversationOutputSchema,
  execute: async ({inputData}) => {
    const {sessionId, totalInputTokens, totalOutputTokens, tokenMap} =
      inputData;

    debug(
      `PersistConversation: memory-managed persistence for session=${sessionId}`,
    );

    return {sessionId, totalInputTokens, totalOutputTokens, tokenMap};
  },
});
