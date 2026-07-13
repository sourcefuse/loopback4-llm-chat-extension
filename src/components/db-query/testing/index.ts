// Consumer-facing acceptance-test utility: drive the /reply endpoint with
// prompt→SQL cases and report accuracy. Endpoint-driven, so it is
// unchanged by the LangGraph→Mastra migration (the SSE event contract is
// preserved). The graph-coupled builders (db-query.graph.builder,
// get-table.node.builder) were intentionally not restored — they targeted
// the deleted LangGraph internals.
export * from './types';
export * from './utils';
export * from './generation.acceptance.builder';
