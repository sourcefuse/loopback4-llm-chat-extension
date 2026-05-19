import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
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
 *  - Call `chatStore.init()` to create or fetch the session
 *  - Persist the user's message to the database
 *  - Emit the `Init` SSE event for new sessions via writer.write() (workflow-native streaming)
 *
 * Retry: 2 attempts (DB availability issues)
 * Error: Throws if chatStore.init() fails after retries
 */
export const initSessionStep = createStep({
  id: 'init-session',
  description:
    'Initialise or resume a chat session; persist the user message; emit Init event',
  inputSchema: ChatWorkflowInputSchema,
  outputSchema: InitSessionOutputSchema,
  retries: 2,
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asWorkflowContext(requestContext);
    const chatStore = ctx.get('chatStore');

    const {prompt, files, sessionId} = inputData;
    const isNewSession = !sessionId;

    debug(
      `InitSession: isNew=${isNewSession}, sessionId=${sessionId ?? 'none'}`,
    );

    // Create or resume the session
    const chat = await chatStore.init(prompt, sessionId);

    // Emit Init event via writer (workflow-native streaming, not AsyncEventQueue)
    if (isNewSession) {
      debug(`Emitting Init event for new session ${chat.id}`);
      await writer.write({
        type: LLMStreamEventType.Init,
        data: {sessionId: chat.id},
      });
    }

    // Persist the human message to the database
    const savedUserMessage = await chatStore.addHumanMessageText(
      chat.id,
      prompt,
    );

    return {
      sessionId: chat.id,
      isNewSession,
      userMessageId: savedUserMessage?.id,
      prompt,
      files: files as z.infer<typeof InitSessionOutputSchema>['files'],
    };
  },
});
