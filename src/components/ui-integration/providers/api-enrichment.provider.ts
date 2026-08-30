import {Provider} from '@loopback/core';
import {FormFieldConfig, IApiEnrichmentFn} from '../types';
import {HttpErrors} from '@loopback/rest';

export class ApiEnrichmentProvider implements Provider<IApiEnrichmentFn> {
  value(): IApiEnrichmentFn {
    return async (fieldConfig: FormFieldConfig, userContext?: any) => {
      // Default implementation - users should override this
      // This could make HTTP requests to external APIs
      throw new HttpErrors.NotImplemented(
        `ApiEnrichmentProvider not implemented`,
      );
    };
  }
}
