import {expect} from '@loopback/testlab';
import {FormStore} from '../../../../components/ui-integration/form-registry.service';
import {FormConfig} from '../../../../components/ui-integration/types';

describe('FormStore Unit', function () {
  let formStore: FormStore;
  let mockForm: FormConfig;

  beforeEach(async () => {
    formStore = new FormStore();
    mockForm = {
      id: 'test-form-1',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
        },
        {
          name: 'email',
          type: 'text',
          required: true,
        },
      ],
    };
  });

  it('should register a form successfully', () => {
    formStore.register(mockForm);

    const retrieved = formStore.get('test-form-1');

    expect(retrieved).to.not.be.undefined();
    expect(retrieved!.id).to.equal('test-form-1');
    expect(retrieved!.name).to.equal('Test Form');
  });

  it('should return undefined for non-existent form', () => {
    const retrieved = formStore.get('non-existent');

    expect(retrieved).to.be.undefined();
  });

  it('should return all forms', () => {
    const form2: FormConfig = {
      id: 'test-form-2',
      name: 'Test Form 2',
      description: 'Another test form',
      fields: [],
    };

    formStore.register(mockForm);
    formStore.register(form2);

    const allForms = formStore.getAll();

    expect(allForms).to.have.lengthOf(2);
    expect(allForms.map(f => f.id)).to.containEql('test-form-1');
    expect(allForms.map(f => f.id)).to.containEql('test-form-2');
  });

  it('should return empty array when no forms registered', () => {
    const allForms = formStore.getAll();

    expect(allForms).to.be.an.Array();
    expect(allForms).to.be.empty();
  });

  it('should overwrite form with same ID', () => {
    formStore.register(mockForm);

    const updatedForm: FormConfig = {
      ...mockForm,
      name: 'Updated Test Form',
    };

    formStore.register(updatedForm);

    const retrieved = formStore.get('test-form-1');

    expect(retrieved).to.not.be.undefined();
    expect(retrieved!.name).to.equal('Updated Test Form');
    expect(formStore.getAll()).to.have.lengthOf(1);
  });
});
