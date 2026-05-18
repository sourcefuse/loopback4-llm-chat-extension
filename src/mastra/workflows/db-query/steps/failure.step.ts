import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';

/**
 * FailureStep — replaces FailedNode.
 *
 * Emits a ToolStatus.Failed event and returns a user-facing error message.
 */
export const failureStep = createStep({
  id: 'failure',
  inputSchema: z.object({
    replyToUser: z.string().optional(),
    feedbacks: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    replyToUser: z.string(),
  }),
  execute: async ({inputData, writer}) => {
    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'failed'},
    });

    const replyToUser =
      inputData.replyToUser ??
      `I am sorry, I was not able to generate a valid SQL query for your request. Please try again with a more detailed or a more specific prompt.\n` +
        `These were the errors I encountered:\n${inputData.feedbacks?.join('\n') ?? 'No errors reported.'}`;

    return {replyToUser};
  },
});
