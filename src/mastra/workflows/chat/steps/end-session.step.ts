import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
import {
  PersistConversationOutputSchema,
  ChatWorkflowOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')('ai-integration:mastra:end-session.step');

/**
 * EndSessionStep — finalise the chat turn and emit the TokenCount event.
 *
 * LangGraph equivalent: `EndSessionNode`.
 *
 * Responsibilities:
 *  - Update the session's cumulative token counts in the database
 *  - Emit the TokenCount SSE event via writer.write() (workflow-native streaming)
 *
 * The AsyncEventQueue is NOT closed here — it is closed by AgentReasoningStep
 * after agent.stream() completes. EndSession only handles DB updates and the
 * TokenCount event, which flows through the workflow stream (writer), not the queue.
 */
export const endSessionStep = createStep({
  id: 'end-session',
  description:
    'Update token counts in the DB; emit TokenCount event via writer',
  inputSchema: PersistConversationOutputSchema,
  outputSchema: ChatWorkflowOutputSchema,
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asWorkflowContext(requestContext);
    const chatStore = ctx.get('chatStore');

    const {sessionId, totalInputTokens, totalOutputTokens, tokenMap} =
      inputData;

    debug(
      `EndSession: session=${sessionId}, in=${totalInputTokens}, out=${totalOutputTokens}`,
    );

    // Update cumulative token counts in the database
    try {
      await chatStore.updateCounts(
        sessionId,
        totalInputTokens,
        totalOutputTokens,
        tokenMap,
      );
    } catch (err) {
      // Non-fatal — log and continue
      debug('EndSession: failed to update token counts:', err);
    }

    // Emit TokenCount via writer (workflow-native streaming, not AsyncEventQueue)
    await writer.write({
      type: LLMStreamEventType.TokenCount,
      data: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    });

    debug('EndSession: TokenCount event written, step complete');

    return {
      sessionId,
    } satisfies z.infer<typeof ChatWorkflowOutputSchema>;
  },
});
