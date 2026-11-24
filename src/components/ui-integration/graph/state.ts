import {Annotation} from '@langchain/langgraph';
import {FormConfig, FormFieldValue, FormFillStatus} from '../types';

export const FormFillingGraphAnnotation = Annotation.Root({
  prompt: Annotation<string>,
  formConfig: Annotation<FormConfig>,
  extractedFields: Annotation<FormFieldValue[]>,
  validatedFields: Annotation<FormFieldValue[]>,
  enrichedFields: Annotation<FormFieldValue[]>,
  finalFields: Annotation<FormFieldValue[]>,
  missingFields: Annotation<string[]>,
  fieldsNeedingDatabase: Annotation<string[]>,
  fieldsNeedingAPI: Annotation<string[]>,
  formId: Annotation<string>,
  status: Annotation<FormFillStatus>,
  errors: Annotation<string[]>,
  retryCount: Annotation<number>,
  userContext: Annotation<Record<string, any>>,
});

export type FormFillingState = typeof FormFillingGraphAnnotation.State;
