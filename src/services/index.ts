export * from './chat-ledger.service';
export * from './generation.service';
export * from './limit-strategies';
export * from './usage-accumulator.service';
// Back-compat alias: the LangGraph extension exported `TokenCounter`; its
// Mastra successor is `UsageAccumulator` (same role — per-request token
// accounting). Re-exported under the original name so existing host imports
// (`import {TokenCounter} from 'lb4-llm-chat-component'`) keep resolving.
export {UsageAccumulator as TokenCounter} from './usage-accumulator.service';
