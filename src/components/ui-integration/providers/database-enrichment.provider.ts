import {Provider} from '@loopback/core';
import {FormFieldConfig, DatabaseEnrichmentFn} from '../types';
import {HttpErrors} from '@loopback/rest';

export class DatabaseEnrichmentProvider
  implements Provider<DatabaseEnrichmentFn>
{
  value(): DatabaseEnrichmentFn {
    return async (fieldConfig: FormFieldConfig, userContext?: any) => {
      // Default implementation - users should override this
      // This could use a repository to query the database
      throw new HttpErrors.NotImplemented(
        `DatabaseEnrichmentProvider not implemented`,
      );
    };
  }
}
