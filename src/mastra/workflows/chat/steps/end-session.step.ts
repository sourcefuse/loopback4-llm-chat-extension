import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
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
 *  - Emit the TokenCount SSE event via writer.write() (workflow-native streaming)
 *
 * The AsyncEventQueue is NOT closed here — it is closed by AgentReasoningStep
 * after agent.stream() completes. EndSession only handles the
 * TokenCount event, which flows through the workflow stream (writer), not the queue.
 */
export const endSessionStep = createStep({
  id: 'end-session',
  description: 'Emit TokenCount event via writer',
  inputSchema: PersistConversationOutputSchema,
  outputSchema: ChatWorkflowOutputSchema,
  execute: async ({inputData, writer}) => {
    const {sessionId, totalInputTokens, totalOutputTokens} = inputData;

    debug(
      `EndSession: session=${sessionId}, in=${totalInputTokens}, out=${totalOutputTokens}`,
    );

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
