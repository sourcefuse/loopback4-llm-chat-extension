import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject} from '@loopback/context';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {FormFillingState} from '../graph/state';
import {FormFillStatus, FormFieldValue} from '../types';
import {FormFillingNodes} from '../nodes.enum';

@graphNode(FormFillingNodes.ExtractInfo)
export class ExtractInfoNode implements IGraphNode<FormFillingState> {
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly llm: LLMProvider,
  ) {}

  prompt = PromptTemplate.fromTemplate(`
You are an AI assistant that extracts form field values from user's natural language request.

Form to fill: {formName}
Form description: {formDescription}

Fields to extract:
{fields}

User's request: {request}

Additional context from previous attempts:
{previousErrors}

Extract the values for each field from the user's request. Return a JSON object with field names as keys and extracted values.
For fields that cannot be determined from the request, use null.
Include a "confidence" score (0-1) for each extracted value.

Format:
{{
  "fieldName": {{"value": "extracted value", "confidence": 0.9}},
  "anotherField": {{"value": null, "confidence": 0.0}}
}}

Return ONLY valid JSON, no other text.
`);

  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    if (!state.formConfig) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: ['Form configuration not found'],
      };
    }

    const fieldsDescription = state.formConfig.fields
      .map(f => {
        let desc = `- ${f.name} (${f.type})`;
        if (f.required) desc += ' [REQUIRED]';
        if (f.description) desc += `: ${f.description}`;
        if (f.options) desc += ` Options: ${f.options.join(', ')}`;
        return desc;
      })
      .join('\n');

    const chain = RunnableSequence.from([this.prompt, this.llm]);

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Extracting information from your request...'},
    });

    const result = await chain.invoke({
      formName: state.formConfig.name,
      formDescription: state.formConfig.description,
      fields: fieldsDescription,
      request: state.prompt,
      previousErrors: state.errors?.join('\n') || 'None',
    });

    try {
      const cleaned = stripThinkingTokens(result);
      const extracted = JSON.parse(cleaned);

      const extractedFields: FormFieldValue[] = Object.entries(extracted).map(
        ([name, data]: [string, any]) => ({
          name,
          value: data.value,
          confidence: data.confidence || 0.5,
          source: 'extracted',
        }),
      );

      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Extracted ${extractedFields.length} fields`,
      });

      return {
        ...state,
        extractedFields,
        retryCount: (state.retryCount || 0) + 1,
      };
    } catch (error) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: [
          ...(state.errors || []),
          `Failed to parse extracted information: ${error}`,
        ],
      };
    }
  }
}
