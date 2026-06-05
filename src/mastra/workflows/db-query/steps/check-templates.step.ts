import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getTemplateCache,
  tracedGenerateText,
} from '../_helpers';
import {inputSchema, STEP_CHECK_TEMPLATES} from './constants';

export const checkTemplatesStep = createStep({
  id: STEP_CHECK_TEMPLATES,
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    const data = inputData as {prompt?: string};
    if (!data.prompt) return {matched: false};

    const cache = getTemplateCache(requestContext);
    const chatLlm = getCheapLlm(requestContext);
    if (!cache || !chatLlm) return {matched: false};

    let docs: Array<{pageContent: string; metadata: {id?: string}}> = [];
    try {
      docs = await cache.invoke(data.prompt);
    } catch {
      return {matched: false};
    }

    if (docs.length === 0) return {matched: false};

    const templates = docs
      .map((d, i) => `${i + 1}. ${d.pageContent}`)
      .join('\n');
    const judgePrompt = `You are an expert at matching user prompts to query templates. A template matches ONLY when its purpose and result are EXACTLY what the user asked — no extra columns, no missing filters, only placeholder values differ.

User prompt: ${data.prompt}
Templates:
${templates}

Return 'match <index>' for an exact match or 'no_match'. No other text.`;

    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: judgePrompt,
        tracing: tracingContext,
        label: 'template-judge',
        resultType: 'reasoning',
      });

      const text = verdict.text.trim();
      const match = text.match(/match\s+(\d+)/i);
      if (match) {
        emitToolStatus(
          requestContext,
          STEP_CHECK_TEMPLATES,
          'Matched query template',
        );
        const idx = parseInt(match[1], 10) - 1;
        const doc = docs[idx];
        if (doc?.metadata?.id) {
          return {matched: true, templateId: doc.metadata.id};
        }
      }
    } catch {
      // degrade to no match on judge failure
    }

    return {matched: false};
  },
});
