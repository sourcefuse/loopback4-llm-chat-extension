import {END, START, StateGraph} from '@langchain/langgraph';
import {BaseGraph} from '../../../graphs';
import {FormFillingGraphAnnotation, FormFillingState} from './state';
import {FormFillingNodes} from '../nodes.enum';
import {FormFillStatus} from '../types';

export class FormFillingGraph extends BaseGraph<FormFillingState> {
  async build() {
    const graph = new StateGraph(FormFillingGraphAnnotation);

    // Pre-fetch all node functions to avoid complex async type inference
    const identifyFormFn = await this._getNodeFn(FormFillingNodes.IdentifyForm);
    const extractInfoFn = await this._getNodeFn(FormFillingNodes.ExtractInfo);
    const validateFieldsFn = await this._getNodeFn(
      FormFillingNodes.ValidateFields,
    );
    const enrichFieldsFn = await this._getNodeFn(FormFillingNodes.EnrichFields);
    const missingFieldsFn = await this._getNodeFn(
      FormFillingNodes.MissingFields,
    );
    const failedFn = await this._getNodeFn(FormFillingNodes.FailedUI);

    graph
      // Add nodes
      .addNode(FormFillingNodes.IdentifyForm, identifyFormFn)
      .addNode(FormFillingNodes.ExtractInfo, extractInfoFn)
      .addNode(FormFillingNodes.ValidateFields, validateFieldsFn)
      .addNode(FormFillingNodes.EnrichFields, enrichFieldsFn)
      .addNode(FormFillingNodes.MissingFields, missingFieldsFn)
      .addNode(FormFillingNodes.FailedUI, failedFn)

      // Add edges
      .addEdge(START, FormFillingNodes.IdentifyForm)
      .addEdge(FormFillingNodes.IdentifyForm, FormFillingNodes.ExtractInfo)
      .addEdge(FormFillingNodes.ExtractInfo, FormFillingNodes.ValidateFields)
      .addConditionalEdges(
        FormFillingNodes.ValidateFields,
        (state: FormFillingState) => {
          if (state.errors && state.errors.length > 0) {
            if (state.retryCount && state.retryCount >= 3) {
              return FormFillingNodes.FailedUI;
            }
            return FormFillingNodes.ExtractInfo; // Retry extraction
          }
          return FormFillingNodes.EnrichFields;
        },
        {
          [FormFillingNodes.ExtractInfo]: FormFillingNodes.ExtractInfo,
          [FormFillingNodes.EnrichFields]: FormFillingNodes.EnrichFields,
          [FormFillingNodes.FailedUI]: FormFillingNodes.FailedUI,
        },
      )
      .addEdge(FormFillingNodes.EnrichFields, FormFillingNodes.MissingFields)
      .addEdge(FormFillingNodes.FailedUI, END) // ← ADDED: Failed needs to go to END
      .addConditionalEdges(
        FormFillingNodes.MissingFields,
        (state: FormFillingState) => {
          if (state.status === FormFillStatus.Failed) {
            return FormFillingNodes.FailedUI; // Too many missing fields
          }
          return END; // Both Complete and Incomplete end here
        },
        {
          [FormFillingNodes.FailedUI]: FormFillingNodes.FailedUI,
          [END]: END,
        },
      );

    return graph.compile();
  }
}

export {FormFillingGraphAnnotation};
