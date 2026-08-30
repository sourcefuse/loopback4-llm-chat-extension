import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {
  IGraphNode,
  LLMStreamEventType,
  RunnableConfig,
  ToolStatus,
} from '../../../graphs';
import {FormFillingState} from '../graph/state';
import {FormFillStatus, FilledForm, UIIntegrationConfig} from '../types';
import {FormFillingNodes} from '../nodes.enum';
import {UIIntegrationBindings} from '../keys';

@graphNode(FormFillingNodes.MissingFields)
export class MissingFieldsNode implements IGraphNode<FormFillingState> {
  constructor(
    @inject(UIIntegrationBindings.Config)
    private readonly config?: UIIntegrationConfig,
  ) {}

  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    if (!state.formConfig || !state.enrichedFields) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: ['Missing form configuration or enriched fields'],
      };
    }

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Checking for missing required fields...'},
    });

    const missingFields: string[] = [];
    const fieldsNeedingDatabase: string[] = [];
    const fieldsNeedingAPI: string[] = [];
    const finalFields = [...state.enrichedFields];

    // Check for missing required fields
    for (const fieldConfig of state.formConfig.fields) {
      if (fieldConfig.required) {
        const field = finalFields.find(f => f.name === fieldConfig.name);
        if (!field || field.value === null || field.value === undefined) {
          missingFields.push(fieldConfig.name);

          // Categorize by enrichment type
          if (fieldConfig.enrichment) {
            if (fieldConfig.enrichment.dataSource === 'database') {
              fieldsNeedingDatabase.push(fieldConfig.name);
            } else if (fieldConfig.enrichment.dataSource === 'api') {
              fieldsNeedingAPI.push(fieldConfig.name);
            }
          }
        }
      }
    }

    // Add default values for optional fields if specified
    for (const fieldConfig of state.formConfig.fields) {
      if (!fieldConfig.required && fieldConfig.defaultValue !== undefined) {
        const existing = finalFields.find(f => f.name === fieldConfig.name);
        if (!existing || existing.value === null) {
          finalFields.push({
            name: fieldConfig.name,
            value: fieldConfig.defaultValue,
            confidence: 1.0,
            source: 'default',
          });
        }
      }
    }

    // Calculate overall confidence
    const avgConfidence =
      finalFields.reduce((sum, f) => sum + (f.confidence || 0), 0) /
      finalFields.length;

    // Determine status based on missing fields and config
    const maxAllowed = this.config?.maxMissingFields ?? 0;
    let status: FormFillStatus;

    if (missingFields.length === 0) {
      status = FormFillStatus.Complete;
    } else if (missingFields.length <= maxAllowed) {
      status = FormFillStatus.Incomplete;
    } else {
      // Too many missing fields - mark as failed
      status = FormFillStatus.Failed;
    }

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Completed,
        data: {
          formId: state.formId,
          status,
          missingFields: missingFields.length,
          maxAllowedMissing: maxAllowed,
          confidence: avgConfidence,
          ...(status === FormFillStatus.Failed && {
            reason: `Too many missing fields (${missingFields.length}). Maximum allowed: ${maxAllowed}`,
          }),
        },
      },
    });

    return {
      ...state,
      finalFields,
      missingFields,
      fieldsNeedingDatabase,
      fieldsNeedingAPI,
      status,
      ...(status === FormFillStatus.Failed && {
        errors: [
          `Too many missing required fields (${missingFields.length}). Maximum allowed: ${maxAllowed}. Missing: ${missingFields.join(', ')}`,
        ],
      }),
    };
  }
}
