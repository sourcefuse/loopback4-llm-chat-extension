import {service} from '@loopback/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {IMastraGraphTool} from '../../../graphs/types';
import {AskAboutDatasetTool} from './ask-about-dataset.tool';

/**
 * Mastra-shaped wrapper around the legacy dataset Q&A tool. Delegates to
 * the existing RunnableSequence (PromptTemplate -> LLM -> stripThinking)
 * via the legacy class's .build().invoke(). This tool is read-only and
 * does not emit ToolStatus events.
 */
export class MastraAskAboutDatasetTool implements IMastraGraphTool {
  key = 'ask-about-dataset';
  requireApproval = false;

  constructor(
    @service(AskAboutDatasetTool)
    private readonly legacy: AskAboutDatasetTool,
  ) {}

  build(): Tool {
    return createTool({
      id: this.key,
      description:
        'Tool for answering questions about an existing dataset, note that it can only answer questions about the dataset definition, not the data it contains. Call this only if you have a valid dataset ID available.',
      inputSchema: z.object({
        datasetId: z
          .string()
          .describe('uuid ID of the dataset to answer the question for'),
        question: z
          .string()
          .describe('The question that the user asked about the query.'),
      }),
      execute: async inputData => {
        const legacyTool = await this.legacy.build();
        const result = await legacyTool.invoke(inputData as unknown as never);
        return result;
      },
    });
  }
}
