import {Getter, inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {FormFillingState} from '../graph/state';
import {FormFillStatus, FormFieldValue} from '../types';
import {FormFillingNodes} from '../nodes.enum';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';

@graphNode(FormFillingNodes.EnrichFields)
export class EnrichFieldsNode implements IGraphNode<FormFillingState> {
  constructor(
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    protected readonly getCurrentUser: Getter<
      IAuthUserWithPermissions | undefined
    >,
  ) {}

  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    if (!state.formConfig || !state.validatedFields) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: ['Missing form configuration or validated fields'],
      };
    }

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Enriching form fields with user context...'},
    });

    const enrichedFields: FormFieldValue[] = [];

    const currentUser = await this.getCurrentUser();

    for (const field of state.validatedFields) {
      const fieldConfig = state.formConfig!.fields.find(
        f => f.name === field.name,
      );

      // Skip if field already has a value
      if (field.value !== null && field.value !== undefined) {
        enrichedFields.push(field);
        continue;
      }

      // Skip if no enrichment config
      if (!fieldConfig?.enrichment) {
        enrichedFields.push(field);
        continue;
      }

      let enrichedValue = field.value;
      let source = field.source;

      // Only handle user-context enrichment
      // Database and API enrichment are handled by LLM tools (generate-query, etc.)
      if (
        fieldConfig.enrichment.dataSource === 'user-context' &&
        fieldConfig.enrichment.userContextField &&
        currentUser
      ) {
        // Support nested properties like 'userProfile.department'
        enrichedValue = this.getNestedValue(
          currentUser,
          fieldConfig.enrichment.userContextField,
        );
        if (enrichedValue !== undefined) {
          source = 'enriched';
        }

        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `Enriched ${field.name} from current user: ${fieldConfig.enrichment.userContextField}`,
        });
      }

      // Note: database and API enrichment are skipped
      // The LLM will call generate-query or other tools to fetch that data
      if (
        fieldConfig.enrichment.dataSource === 'database' ||
        fieldConfig.enrichment.dataSource === 'api'
      ) {
        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `Field ${field.name} requires ${fieldConfig.enrichment.dataSource} enrichment - will be handled by LLM calling appropriate tools`,
        });
      }

      enrichedFields.push({
        ...field,
        value: enrichedValue,
        source,
      });
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Enriched ${enrichedFields.filter(f => f.source === 'enriched').length} fields from user context`,
    });

    return {
      ...state,
      enrichedFields,
    };
  }

  /**
   * Helper: Get nested value from object using dot notation
   * Example: getNestedValue(user, 'userProfile.department') → user.userProfile.department
   */
  private getNestedValue(obj: any, path: string): any {
    if (!obj || !path) return undefined;

    const keys = path.split('.');
    let value = obj;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }
}
