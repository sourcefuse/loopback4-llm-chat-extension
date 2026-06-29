export const TOOL_TAG = 'isTOOL';
export const TOOL_NAME = 'TOOL';
export const GRAPH_NODE_TAG = 'isNODE';
export const GRAPH_NODE_NAME = 'GRAPH_NODE';
// Mastra-named equivalents of the LangGraph node tags above. A `@step(key)`
// class is stamped `isSTEP: true` + `STEP: <key>`, so a workflow step is
// discovered by tag (`context.findByTag({STEP: key})`) and resolved from DI —
// exactly the BaseGraph._getNodeFn seam, in Mastra vocabulary. This is what
// makes individual steps overrideable by a host app: rebind the tagged class.
export const STEP_TAG = 'isSTEP';
export const STEP_NAME = 'STEP';
// Marks a step binding as a BUNDLED default (stamped on the library's own
// `@step` registrations). When a host binds its own `@step(key)` class with the
// same key, two bindings share the tag; the resolver prefers the one WITHOUT
// this marker, so a consumer override wins without having to unbind the default.
export const STEP_DEFAULT = 'stepDefault';
// Default token budget for the chat agent's TokenLimiter input processor — it
// trims the OLDEST non-system messages to keep the request within this budget.
// It is NOT a cost-trim threshold: if the SYSTEM prompt alone exceeds this, the
// TokenLimiter cannot trim (it won't drop system messages) and HARD-BLOCKS the
// request ("System messages alone exceed token limit"). The old v2 value (8192)
// was a LangGraph ContextCompressionNode trim threshold; reused as a hard gate
// it blocked any consumer whose schema/domain system prompt is large. Modern
// models (Claude/Gemini) have 200k–1M windows, so default to a budget that
// comfortably fits a large system prompt while still capping runaway history.
// Consumers tune via MAX_TOKEN_COUNT env / AIIntegrationConfig.maxTokenCount.
export const DEFAULT_MAX_TOKEN_COUNT = 32000;
export const MB = 1024 * 1024; // 1 MB in bytes
const FIVE = 5;
const TWENTY = 20;
export const DEFAULT_FILE_SIZE = FIVE * MB;
export const MAX_TOTAL_SIZE = TWENTY * MB;
export const MAX_CONSTRAINT_NAME_LENGTH = 63; // PostgreSQL limit for constraint names
export const CHAT_TITLE_MAX_LENGTH = 200; // Maximum length for chat title
