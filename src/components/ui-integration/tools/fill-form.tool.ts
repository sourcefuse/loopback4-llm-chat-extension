import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, ToolStatus} from '../../../graphs';
import {FormFillStatus} from '../types';
import {StructuredToolInterface} from '@langchain/core/tools';
import {RunnableToolLike} from '@langchain/core/runnables';
import {FormFillingGraph} from '../graph';

@graphTool()
export class FillFormTool implements IGraphTool {
  needsReview = false;
  key = 'fill-form';

  constructor(
    @inject('services.FormFillingGraph')
    private readonly formFillingGraph: FormFillingGraph,
  ) {}

  getValue(result: Record<string, any>): string {
    const status = result.status as FormFillStatus;
    const formConfig = result.formConfig;
    const formName = formConfig?.name || result.formName || 'unknown form';
    const finalFields = result.finalFields || [];
    const missingFields = result.missingFields || [];
    const missingDbFields = result.fieldsNeedingDatabase || [];
    const missingApiFields = result.fieldsNeedingAPI || [];

    if (status === FormFillStatus.Failed) {
      return `Failed to fill form: ${formName}`;
    }

    // Check if we need to fetch data from database
    if (missingDbFields.length > 0) {
      return `FORM INCOMPLETE: The form "${formName}" requires data from database for these fields: ${missingDbFields.join(', ')}.

ACTION REQUIRED: For EACH field listed above:
1. Call generate-query to CREATE a dataset (e.g., "Get email for employee EMP123")
2. Call execute-dataset with the dataset ID to GET the actual values (e.g., datasetId="ds_123")
3. Extract the data values from the execute-dataset results

After fetching ALL database values, call fill-form AGAIN with complete data.
Example: fill-form("Fill form with employeeEmail: john@company.com, department: Engineering")`;
    }

    // Check if we need to fetch data from API
    if (missingApiFields.length > 0) {
      return `FORM INCOMPLETE: The form "${formName}" requires data from external APIs for these fields: ${missingApiFields.join(', ')}.

ACTION REQUIRED: Fetch the data for each field using the appropriate API, then call fill-form again with the complete data.`;
    }

    if (status === FormFillStatus.Incomplete) {
      return `Form "${formName}" partially filled. Missing required fields: ${missingFields.join(', ')}. Please provide the missing information.`;
    }

    // Calculate confidence from final fields
    const avgConfidence =
      finalFields.length > 0
        ? finalFields.reduce((sum: number, f: any) => sum + (f.confidence || 0), 0) /
          finalFields.length
        : 0;

    return `Successfully filled form "${formName}" with ${finalFields.length} fields. Overall confidence: ${(avgConfidence * 100).toFixed(0)}%. The form is ready for submission.`;
  }

  getMetadata(result: Record<string, any>): any {
    const formConfig = result.formConfig as any;
    return {
      status:
        result.status === FormFillStatus.Complete
          ? ToolStatus.Completed
          : ToolStatus.Failed,
      formId: result.formId || '',
      formName: result.formName || formConfig?.name || 'unknown form',
      missingFields:
        result.missingFields && result.missingFields.length > 0
          ? String(result.missingFields).split(',')
          : [],
      fieldsNeedingDatabase: result.fieldsNeedingDatabase || [],
      fieldsNeedingAPI: result.fieldsNeedingAPI || [],
    };
  }

  async build(): Promise<StructuredToolInterface | RunnableToolLike> {
    const graph = await this.formFillingGraph.build();
    const schema = z.object({
      prompt: z
        .string()
        .describe(
          'User request describing what form to fill and with what information',
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description: `Fills out a pre-configured form based on user's natural language request. Identifies the appropriate form, extracts information from the request, validates fields, and enriches user-context fields (like employeeId from CURRENT_USER).

IMPORTANT: If the tool response indicates that database fields are needed, you MUST:
1. Call the generate-query tool to CREATE a dataset for each missing field
2. Call the execute-dataset tool with the dataset ID to GET the actual values
3. Call fill-form AGAIN with ALL the fetched values included

Example flow:
- First call: fill-form("Fill employee leave request") → Response: "Need employeeEmail, department from database"
- Second call: generate-query("Get email for employee EMP123") → Response: "Dataset ID: ds_123"
- Third call: execute-dataset(datasetId="ds_123") → Response: [{"email": "john@company.com"}]
- Fourth call: fill-form("Fill employee leave request with employeeEmail: john@company.com, department: Engineering, leaveType: Sick leave") → Success

Use this tool when the user wants to submit any kind of form, request, or application.`,
      schema,
    });
  }
}
