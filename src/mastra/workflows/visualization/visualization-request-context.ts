import type {RequestContext} from '@mastra/core/request-context';
import type {DbQueryRequestContext} from '../db-query/db-query-request-context';
import type {VisualizerStore} from '../../../components/visualization/types';

export type {VisualizerStore} from '../../../components/visualization/types';

export interface VisualizationRequestContext extends DbQueryRequestContext {
  visualizerStore: VisualizerStore;
}

export function asVisualizationContext(
  requestContext: RequestContext,
): RequestContext<VisualizationRequestContext> {
  return requestContext as RequestContext<VisualizationRequestContext>;
}
