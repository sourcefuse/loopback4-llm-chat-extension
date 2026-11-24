export enum EnrichmentDataSource {
  Database = 'database',
  Api = 'api',
  UserContext = 'user-context',
}

export type FormFieldConfig = {
  name: string;
  type:
    | 'text'
    | 'number'
    | 'date'
    | 'select'
    | 'multiselect'
    | 'boolean'
    | 'file';
  required: boolean;
  description?: string;
  options?: string[]; // For select/multiselect
  defaultValue?: any;
  validation?: {
    pattern?: string; // Regex for validation
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
  };
  enrichment?: {
    dataSource?: EnrichmentDataSource | string;
    query?: string; // For database lookup - passed to provider
    apiUrl?: string; // For API lookup - passed to provider - future use
    userContextField?: string; // From user profile (supports nested: 'userProfile.email')
  };
};

export type FormConfig = {
  id: string;
  name: string;
  description: string;
  category?: string;
  keywords?: string[]; // For form identification
  fields: FormFieldConfig[];
  permissions?: {
    readPermissionKey?: string;
    writePermissionKey?: string;
  };
  workflow?: {
    requiresApproval?: boolean;
    notifyOnSubmit?: string[];
  };
};

export type FormFieldValue = {
  name: string;
  value: any;
  confidence?: number; // 0-1, how confident AI is about this value
  source?: 'extracted' | 'enriched' | 'default' | 'user-provided';
};

export type FilledForm = {
  formId: string;
  formName: string;
  fields: FormFieldValue[];
  missingFields: string[];
  confidence: number; // Overall confidence score
  status: FormFillStatus;
  metadata?: {
    extractedAt: Date;
    userId?: string;
    attempts?: number;
  };
};

export type UIIntegrationConfig = {
  forms: FormConfig[];
  defaultDataSource?: {
    datasourceName?: string;
    apiUrl?: string;
  };
  enrichmentEnabled?: boolean;
  maxMissingFields?: number;
};

export enum FormFillStatus {
  Complete = 'complete',
  Incomplete = 'incomplete',
  Failed = 'failed',
}

export enum FieldExtractionStatus {
  Extracted = 'extracted',
  Missing = 'missing',
  Invalid = 'invalid',
  Enriched = 'enriched',
}

/**
 * Interface for database enrichment provider
 * Users can provide their own implementation to fetch data from database
 */
export type DatabaseEnrichmentFn = (
  /**
   * Fetch field value from database based on query
   * @param fieldConfig The field configuration containing the query
   * @param userContext Current user context for filtering (includes extracted fields)
   * @returns The fetched value or undefined if not found
   */

  fieldConfig: FormFieldConfig,
  userContext?: any,
) => Promise<string | number | boolean | undefined>;

/**
 * Interface for API enrichment provider
 * Users can provide their own implementation to fetch data from external APIs
 */
export type IApiEnrichmentFn = (
  /**
   * Fetch field value from external API
   * @param fieldConfig The field configuration containing the API URL
   * @param userContext Current user context for authentication/headers (includes extracted fields)
   * @returns The fetched value or undefined if not found
   */
  fieldConfig: FormFieldConfig,
  userContext?: any,
) => Promise<string | number | boolean | undefined>;
