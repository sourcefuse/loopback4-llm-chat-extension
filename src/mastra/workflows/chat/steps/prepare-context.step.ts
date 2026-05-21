import {createStep} from '@mastra/core/workflows';
import {
  InitSessionOutputSchema,
  PrepareContextOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')('ai-integration:mastra:prepare-context.step');

/**
 * PrepareContextStep — normalize prompt payload before file processing.
 *
 * Thread recall is now handled by Mastra Memory in `agent.stream({memory})`.
 * This step keeps the workflow contract stable while passing prompt/files ahead.
 */
export const prepareContextStep = createStep({
  id: 'prepare-context',
  description: 'Normalize prompt payload before file processing',
  inputSchema: InitSessionOutputSchema,
  outputSchema: PrepareContextOutputSchema,
  execute: async ({inputData}) => {
    const {sessionId, prompt, files} = inputData;

    debug(`PrepareContext: pass-through for session=${sessionId}`);

    return {
      sessionId,
      prompt,
      files: files ?? [],
    };
  },
});
