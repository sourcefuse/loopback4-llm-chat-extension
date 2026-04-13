import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {FormFillingState} from '../graph/state';
import {FormFillStatus, FormFieldValue} from '../types';
import {FormFillingNodes} from '../nodes.enum';

@graphNode(FormFillingNodes.ValidateFields)
export class ValidateFieldsNode implements IGraphNode<FormFillingState> {
  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    if (!state.formConfig || !state.extractedFields) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: ['Missing form configuration or extracted fields'],
      };
    }

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Validating extracted fields and checking what can be enriched...'},
    });

    const errors: string[] = [];
    const validatedFields: FormFieldValue[] = [];

    for (const field of state.formConfig.fields) {
      const extracted = state.extractedFields.find(f => f.name === field.name);

      // Check required fields
      if (
        field.required &&
        (!extracted ||
          extracted.value === null ||
          extracted.value === undefined)
      ) {
        // If field has enrichment configured, don't treat missing as an error
        // EnrichFields will fill it in
        if (field.enrichment) {
          config.writer?.({
            type: LLMStreamEventType.Log,
            data: `Field "${field.name}" is missing but will be enriched`,
          });
          validatedFields.push({
            name: field.name,
            value: null,
            confidence: 0,
            source: 'extracted',
          });
          continue;
        }

        // Only error if required field cannot be enriched
        errors.push(`Required field "${field.name}" is missing`);
        validatedFields.push({
          name: field.name,
          value: null,
          confidence: 0,
          source: 'extracted',
        });
        continue;
      }

      // Skip validation for missing optional fields
      if (!extracted || extracted.value === null) {
        continue;
      }

      // Type validation
      let isValid = true;
      let validationError = '';

      switch (field.type) {
        case 'number':
          if (isNaN(Number(extracted.value))) {
            isValid = false;
            validationError = `Field "${field.name}" must be a number`;
          }
          break;

        case 'date':
          if (isNaN(Date.parse(extracted.value))) {
            isValid = false;
            validationError = `Field "${field.name}" must be a valid date`;
          }
          break;

        case 'boolean':
          if (
            typeof extracted.value !== 'boolean' &&
            extracted.value !== 'true' &&
            extracted.value !== 'false'
          ) {
            isValid = false;
            validationError = `Field "${field.name}" must be a boolean`;
          }
          break;

        case 'select':
          if (field.options && !field.options.includes(extracted.value)) {
            isValid = false;
            validationError = `Field "${field.name}" must be one of: ${field.options.join(', ')}`;
          }
          break;

        case 'multiselect':
          if (!Array.isArray(extracted.value)) {
            isValid = false;
            validationError = `Field "${field.name}" must be an array`;
          } else if (field.options) {
            const invalid = extracted.value.filter(
              v => !field.options!.includes(v),
            );
            if (invalid.length > 0) {
              isValid = false;
              validationError = `Field "${field.name}" has invalid values: ${invalid.join(', ')}`;
            }
          }
          break;
      }

      // Pattern validation
      if (isValid && field.validation?.pattern) {
        const regex = new RegExp(field.validation.pattern);
        if (!regex.test(String(extracted.value))) {
          isValid = false;
          validationError = `Field "${field.name}" does not match the required format`;
        }
      }

      // Min/max validation for numbers
      if (isValid && field.type === 'number') {
        const numValue = Number(extracted.value);
        if (
          field.validation?.min !== undefined &&
          numValue < field.validation.min
        ) {
          isValid = false;
          validationError = `Field "${field.name}" must be at least ${field.validation.min}`;
        }
        if (
          field.validation?.max !== undefined &&
          numValue > field.validation.max
        ) {
          isValid = false;
          validationError = `Field "${field.name}" must be at most ${field.validation.max}`;
        }
      }

      if (!isValid) {
        errors.push(validationError);
      }

      validatedFields.push({
        ...extracted,
        value: isValid ? extracted.value : null,
      });
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Validated ${validatedFields.length} fields, ${errors.length} errors`,
    });

    return {
      ...state,
      validatedFields,
      errors: errors.length > 0 ? errors : state.errors || [],
    };
  }
}
