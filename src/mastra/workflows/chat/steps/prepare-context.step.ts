import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {ContextWindowManager} from '../../../bridge/context-window-manager';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
import {
  InitSessionOutputSchema,
  PrepareContextOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')('ai-integration:mastra:prepare-context.step');

/**
 * PrepareContextStep — build the conversation history for the agent.
 *
 * LangGraph equivalent: combines `InitSessionNode`'s message loading and
 * `ContextCompressionNode`'s trimming logic.
 *
 * Responsibilities:
 *  - Fetch all messages for the session from the database
 *  - Convert to CoreMessage format (Vercel AI SDK / Mastra-compatible)
 *  - Trim the history to fit within the context window
 *
 * Note: The current user message (just saved by InitSessionStep) IS included
 * in the history. FileProcessingStep will replace the last user message with
 * an enhanced version (prompt + file summaries) if files were uploaded.
 */
export const prepareContextStep = createStep({
  id: 'prepare-context',
  description:
    'Load conversation history from the database and trim to context window',
  inputSchema: InitSessionOutputSchema,
  outputSchema: PrepareContextOutputSchema,
  execute: async ({inputData, requestContext}) => {
    const ctx = asWorkflowContext(requestContext);
    const chatStore = ctx.get('chatStore');
    const aiConfig = ctx.get('aiConfig') as {maxTokens?: number} | undefined;

    const {sessionId, prompt, files, userMessageId} = inputData;

    debug(`PrepareContext: loading history for session=${sessionId}`);

    const rawMessages = await chatStore.getMessages(sessionId);
    debug(`PrepareContext: loaded ${rawMessages.length} messages`);

    const coreMessages: z.infer<typeof PrepareContextOutputSchema>['messages'] =
      [];
    for (const msg of rawMessages) {
      const coreMsg = await chatStore.toCoreMessage(msg);
      if (coreMsg) {
        coreMessages.push(
          coreMsg as z.infer<
            typeof PrepareContextOutputSchema
          >['messages'][number],
        );
      }
    }

    const maxTokens =
      (aiConfig as {maxTokens?: number} | undefined)?.maxTokens ??
      ContextWindowManager.DEFAULT_MAX_TOKENS;
    const trimmedMessages = ContextWindowManager.trim(coreMessages, maxTokens);

    debug(
      `PrepareContext: ${coreMessages.length} → ${trimmedMessages.length} messages after trim`,
    );

    return {
      sessionId,
      messages: trimmedMessages as z.infer<
        typeof PrepareContextOutputSchema
      >['messages'],
      userMessageId,
      prompt,
      files: (files ?? []) as z.infer<
        typeof PrepareContextOutputSchema
      >['files'],
    };
  },
});
