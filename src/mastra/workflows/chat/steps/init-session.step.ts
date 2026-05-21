import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {
  ChatWorkflowInputSchema,
  InitSessionOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')('ai-integration:mastra:init-session.step');

/**
 * InitSessionStep — initialises or resumes a chat session.
 *
 * LangGraph equivalent: `InitSessionNode`
 *
 * Responsibilities:
 *  - Read the resolved thread id from workflow input
 *  - Emit the `Init` SSE event for new sessions via writer.write() (workflow-native streaming)
 *
 * Retry: 2 attempts
 * Error: Throws if WorkflowRunner did not resolve a session id
 */
export const initSessionStep = createStep({
  id: 'init-session',
  description:
    'Initialise or resume a chat session and emit Init event when needed',
  inputSchema: ChatWorkflowInputSchema,
  outputSchema: InitSessionOutputSchema,
  retries: 2,
  execute: async ({inputData, writer}) => {
    const {prompt, files, sessionId, isNewSession = false} = inputData;

    if (!sessionId) {
      throw new Error(
        'Chat session id was not resolved before init-session execution.',
      );
    }

    debug(
      `InitSession: isNew=${isNewSession}, sessionId=${sessionId ?? 'none'}`,
    );

    // Emit Init event via writer (workflow-native streaming, not AsyncEventQueue)
    if (isNewSession) {
      debug(`Emitting Init event for new session ${sessionId}`);
      await writer.write({
        type: LLMStreamEventType.Init,
        data: {sessionId},
      });
    }

    return {
      sessionId,
      isNewSession,
      prompt,
      files: files as z.infer<typeof InitSessionOutputSchema>['files'],
    };
  },
});
