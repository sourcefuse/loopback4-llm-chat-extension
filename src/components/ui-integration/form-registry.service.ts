import {inject, injectable} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {repository} from '@loopback/repository';
import {UIIntegrationBindings} from './keys';
import {FormConfig, UIIntegrationConfig} from './types';

@injectable()
export class FormStore {
  private forms: Map<string, FormConfig> = new Map();

  register(form: FormConfig): void {
    this.forms.set(form.id, form);
  }

  get(id: string): FormConfig | undefined {
    return this.forms.get(id);
  }

  getAll(): FormConfig[] {
    return Array.from(this.forms.values());
  }
}

@injectable()
export class FormRegistryService {
  private readonly logger = require('debug')(
    'ai-integration:ui-integration:form-registry',
  );

  constructor(
    @inject(UIIntegrationBindings.Config)
    private readonly config: UIIntegrationConfig,
    @inject('services.FormStore')
    private readonly store: FormStore,
  ) {
    // Register all forms from config
    this.logger(`Registering ${this.config.forms.length} forms`);
    this.config.forms.forEach(form => {
      this.logger(`Registering form: ${form.id} - ${form.name}`);
      this.store.register(form);
    });
    this.logger(`Total forms registered: ${this.getAllForms().length}`);
  }

  getAllForms(): FormConfig[] {
    return this.store.getAll();
  }

  getForm(id: string): FormConfig {
    const form = this.store.get(id);
    if (!form) {
      throw new Error(`Form not found: ${id}`);
    }
    return form;
  }

  findForm(nameOrId: string): FormConfig | undefined {
    return this.getAllForms().find(
      f =>
        f.id === nameOrId ||
        f.name.toLowerCase() === nameOrId.toLowerCase() ||
        (f.keywords && f.keywords.some(k => k.toLowerCase() === nameOrId.toLowerCase())),
    );
  }
}
