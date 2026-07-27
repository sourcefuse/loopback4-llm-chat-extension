import {inject} from '@loopback/core';
import {z} from 'zod';
import {tool} from '@langchain/core/tools';
import {StructuredToolInterface} from '@langchain/core/tools';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';
import {FormConfig} from '../types';

@graphTool()
export class GetFormSchemaTool implements IGraphTool {
  needsReview = false;
  key = 'get-form-schema';

  constructor(
    @inject('services.FormRegistryService')
    private readonly formRegistry: any,
  ) {}

  getValue(result: Record<string, string>): string {
    return result.output || result.result || 'Form schema retrieved';
  }

  async build(): Promise<StructuredToolInterface> {
    // @ts-ignore - LangChain complex types cause TypeScript inference issues
    return tool(
      async (input: {formNameOrId: string}) => {
        const form: FormConfig | undefined = await this.formRegistry.findForm(
          input.formNameOrId,
        );
        if (!form) {
          return `Form not found: ${input.formNameOrId}`;
        }

        const fieldsInfo = form.fields
          .map((f: any) => {
            const required = f.required ? 'REQUIRED' : 'OPTIONAL';
            const options = f.options ? `\n  Options: ${f.options.join(', ')}` : '';
            return `- ${f.name} (${f.type}) [${required}]
  Description: ${f.description}${options}`;
          })
          .join('\n\n');

        return `**Form:** ${form.name}

**Description:** ${form.description}

**ID:** ${form.id}
${form.category ? `**Category:** ${form.category}\n` : ''}${form.keywords ? `**Keywords:** ${form.keywords.join(', ')}\n` : ''}**Fields (${form.fields.length} total):**
${fieldsInfo}

---
IMPORTANT: This form contains ONLY the ${form.fields.length} field(s) listed above. No other fields are part of this form configuration.`;
      },
      {
        name: this.key,
        description:
          'Returns complete information about a form including name, description, and ALL configured fields with their types, requirements, and descriptions. Shows ONLY the fields that are explicitly configured.',
        schema: z.object({
          formNameOrId: z.string().describe('The name or ID of the form'),
        }),
      },
    ) as any;
  }
}
