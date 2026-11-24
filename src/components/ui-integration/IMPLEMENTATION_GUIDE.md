# Custom Enrichment Providers Implementation Guide

The UI Integration Component allows you to provide your own implementations for database and API enrichment. This gives you full control over how field values are fetched.

## Default Behavior

By default, the component provides providers that throw `NotImplemented` errors. You **must** provide your own implementations to enable enrichment from databases or APIs.

## Providing Your Own Implementation

The enrichment providers are **functions** (not classes) that you bind in your application.

### 1. Database Enrichment Function

Create a provider class that returns your enrichment function:

```typescript
import {Provider} from '@loopback/core';
import {FormFieldConfig, DatabaseEnrichmentFn} from '@arc/lb4-llm-chat-component/types';

export class MyDatabaseEnrichmentProvider implements Provider<DatabaseEnrichmentFn> {
  constructor(
    @inject('repositories.EmployeeRepository')
    private readonly employeeRepo: EmployeeRepository,
  ) {}

  value(): DatabaseEnrichmentFn {
    return async (fieldConfig: FormFieldConfig, userContext?: any) => {
      // fieldConfig contains the field configuration
      // userContext contains: current user + extracted field values

      switch (fieldConfig.name) {
        case 'employeeId':
          // Return from user context
          return userContext?.employeeId;

        case 'managerName':
          // Query database
          const employee = await this.employeeRepo.findOne({
            where: {id: userContext?.employeeId},
          });
          return employee?.managerName;

        case 'departmentBudget':
          // Query with extracted field values
          const dept = await this.employeeRepo.getDepartmentBudget(
            userContext?.department, // From extracted fields
          );
          return dept?.budget;

        default:
          return undefined;
      }
    };
  }
}
```

### 2. API Enrichment Function

Create a provider class that returns your API enrichment function:

```typescript
import {Provider} from '@loopback/core';
import {FormFieldConfig, IApiEnrichmentFn} from '@arc/lb4-llm-chat-component/types';

export class MyApiEnrichmentProvider implements Provider<IApiEnrichmentFn> {
  constructor(
    @inject('services.HttpService')
    private readonly httpService: HttpService,
  ) {}

  value(): IApiEnrichmentFn {
    return async (fieldConfig: FormFieldConfig, userContext?: any) => {
      // fieldConfig.enrichment.apiUrl contains the API URL from form config
      const apiUrl = fieldConfig.enrichment?.apiUrl;

      if (!apiUrl) {
        return undefined;
      }

      try {
        // Make API request with user context for auth
        const response = await this.httpService.get(apiUrl, {
          headers: {
            Authorization: `Bearer ${userContext?.token}`,
          },
          params: {
            userId: userContext?.id,
            // Use extracted field values as params
            ...this.buildParamsFromContext(userContext),
          },
        });

        return response.data;
      } catch (error) {
        console.error(`API enrichment failed for ${fieldConfig.name}:`, error);
        return undefined;
      }
    };
  }

  private buildParamsFromContext(context: any): Record<string, any> {
    // Extract only serializable values
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value !== 'object' && value !== undefined) {
        params[key] = value;
      }
    }
    return params;
  }
}
```

## Binding Your Providers

In your application's `application.ts`, bind your providers **before** starting the app:

```typescript
import {UIIntegrationBindings} from '@arc/lb4-llm-chat-component';
import {MyDatabaseEnrichmentProvider, MyApiEnrichmentProvider} from './providers';

export class MyApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor() {
    super();

    // ... other bindings

    // Override default enrichment providers with your implementations
    this.bind(UIIntegrationBindings.DatabaseEnrichmentProvider)
      .toProvider(MyDatabaseEnrichmentProvider);

    this.bind(UIIntegrationBindings.ApiEnrichmentProvider)
      .toProvider(MyApiEnrichmentProvider);
  }
}
```

## Form Configuration Examples

### Database Enrichment

```typescript
const forms = [
  {
    id: 'leave-request',
    name: 'Leave Request',
    fields: [
      {
        name: 'employeeId',
        required: true,
        type: 'text',
        enrichment: {
          dataSource: EnrichmentDataSource.Database,
          // This is passed to your provider - you define what it means
          query: 'CURRENT_USER', // Custom identifier your provider understands
        },
      },
      {
        name: 'managerName',
        required: true,
        type: 'text',
        enrichment: {
          dataSource: EnrichmentDataSource.Database,
          query: 'MANAGER_BY_EMPLOYEE_ID',
        },
      },
    ],
  },
];
```

### API Enrichment

```typescript
const forms = [
  {
    id: 'travel-request',
    name: 'Travel Request',
    fields: [
      {
        name: 'exchangeRate',
        required: true,
        type: 'number',
        enrichment: {
          dataSource: EnrichmentDataSource.Api,
          // URL passed to your provider - you handle the request logic
          apiUrl: 'https://api.example.com/rates/latest',
        },
      },
      {
        name: 'travelPolicy',
        required: true,
        type: 'text',
        enrichment: {
          dataSource: EnrichmentDataSource.Api,
          apiUrl: 'https://api.company.com/policies/travel',
        },
      },
    ],
  },
];
```

### User Context Enrichment (Built-in)

No provider needed - uses `AuthenticationBindings.CURRENT_USER`:

```typescript
const forms = [
  {
    id: 'expense-form',
    name: 'Expense Form',
    fields: [
      {
        name: 'email',
        required: true,
        type: 'text',
        enrichment: {
          dataSource: EnrichmentDataSource.UserContext,
          // Supports nested properties
          userContextField: 'userProfile.email',
        },
      },
      {
        name: 'department',
        required: true,
        type: 'text',
        enrichment: {
          dataSource: EnrichmentDataSource.UserContext,
          userContextField: 'department', // Direct property
        },
      },
    ],
  },
];
```

## User Context Structure

The `userContext` parameter passed to your providers includes:

```typescript
{
  // From AuthenticationBindings.CURRENT_USER
  id: string,
  employeeId?: string,
  department?: string,
  manager?: string,
  userProfile?: {
    email?: string,
    fullName?: string,
    // ... other user profile fields
  },

  // Extracted field values from the form (for dependent lookups)
  extractedField1?: any,
  extractedField2?: any,
  // ... all extracted field values are merged in
}
```

## Error Handling

Your providers should gracefully handle errors:

```typescript
value(): DatabaseEnrichmentFn {
  return async (fieldConfig: FormFieldConfig, userContext?: any) => {
    try {
      // Your logic here
      return value;
    } catch (error) {
      // Log but don't throw - enrichment failures shouldn't break the form
      console.error(`Database enrichment failed for ${fieldConfig.name}:`, error);
      return undefined; // Field will remain empty
    }
  };
}
```

## Testing Your Providers

```typescript
import {expect} from '@loopback/testlab';

describe('MyDatabaseEnrichmentProvider', () => {
  it('should fetch manager name for employee', async () => {
    const provider = new MyDatabaseEnrichmentProvider(/* deps */);
    const enrichmentFn = provider.value();

    const fieldConfig = {
      name: 'managerName',
      enrichment: {query: 'MANAGER_BY_EMPLOYEE_ID'},
    } as FormFieldConfig;

    const result = await enrichmentFn(fieldConfig, {
      employeeId: 'EMP123',
    });

    expect(result).to.eql('Jane Smith');
  });
});
```

## Complete Example

See the `/examples` directory for complete working examples of:
- Database enrichment using LoopBack repositories
- API enrichment using external REST services
- User context enrichment with nested properties
- Error handling and logging
