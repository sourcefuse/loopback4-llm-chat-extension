import {inject} from '@loopback/core';
import {z} from 'zod';
import {tool} from '@langchain/core/tools';
import {StructuredToolInterface} from '@langchain/core/tools';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';

@graphTool()
export class ListFormsTool implements IGraphTool {
  needsReview = false;
  key = 'list-forms';

  constructor(
    @inject('services.FormRegistryService')
    private readonly formRegistry: any,
  ) {}

  getValue(result: Record<string, string>): string {
    return result.output || result.result || 'Forms listed';
  }

  async build(): Promise<StructuredToolInterface> {
    // @ts-ignore - LangChain complex types cause TypeScript inference issues
    return tool(
      async () => {
        const forms = await this.formRegistry.getAllForms();
        return forms
          .map((f: any) => {
            const fieldCount = f.fields?.length || 0;
            const requiredCount = f.fields?.filter((field: any) => field.required).length || 0;
            return `- **${f.name}** (ID: ${f.id})
  Description: ${f.description}
  Fields: ${fieldCount} total (${requiredCount} required)${f.keywords ? `\n  Keywords: ${f.keywords.join(', ')}` : ''}`;
          })
          .join('\n\n');
      },
      {
        name: this.key,
        description:
          'Lists all available forms with their names, descriptions, and field counts. Shows only forms that are explicitly configured.',
        schema: z.object({}),
      },
    ) as any;
  }
}
