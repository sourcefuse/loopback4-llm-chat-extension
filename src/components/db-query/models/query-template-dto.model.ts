import {model, Model, property} from '@loopback/repository';

@model()
export class TemplatePlaceholderDTO extends Model {
  @property({
    type: 'string',
    required: true,
    description: 'Name of the placeholder, used as {{name}} in the template',
  })
  name: string;

  @property({
    type: 'string',
    required: true,
    description:
      'Type of the placeholder value: string, number, boolean, sql_expression, or template_ref',
    jsonSchema: {
      enum: ['string', 'number', 'boolean', 'sql_expression', 'template_ref'],
    },
  })
  type: string;

  @property({
    type: 'string',
    required: true,
    description:
      'Description of the placeholder to guide value extraction from user prompts',
  })
  description: string;

  @property({
    type: 'string',
    description:
      'ID of another template to resolve, only for template_ref type',
  })
  templateId?: string;

  @property({
    type: 'string',
    description: 'Default value if not extractable from the user prompt',
  })
  default?: string;

  @property({
    type: 'string',
    description: 'Table name this placeholder is linked to for column context',
  })
  table?: string;

  @property({
    type: 'string',
    description: 'Column name this placeholder is linked to for column context',
  })
  column?: string;

  @property({
    type: 'boolean',
    description:
      'If true, the placeholder is removed when no value is extracted',
  })
  optional?: boolean;

  constructor(data?: Partial<TemplatePlaceholderDTO>) {
    super(data);
  }
}

@model()
export class QueryTemplateDTO extends Model {
  @property({
    type: 'string',
    required: true,
    description:
      'SQL template with {{placeholder_name}} markers for substitution',
  })
  template: string;

  @property({
    type: 'string',
    required: true,
    description:
      'Natural language description of what this template does, used for similarity matching',
  })
  description: string;

  @property({
    type: 'array',
    itemType: TemplatePlaceholderDTO,
    required: true,
    description: 'List of placeholders in the template',
  })
  placeholders: TemplatePlaceholderDTO[];

  @property({
    type: 'array',
    itemType: 'string',
    required: true,
    description: 'Tables used by this template, for permission checks',
  })
  tables: string[];

  @property({
    type: 'string',
    required: true,
    description: 'Canonical prompt this template was created for',
  })
  prompt: string;

  constructor(data?: Partial<QueryTemplateDTO>) {
    super(data);
  }
}
