export const TOOL_TAG = 'isTOOL';
export const TOOL_NAME = 'TOOL';
export const GRAPH_NODE_TAG = 'isNODE';
export const GRAPH_NODE_NAME = 'GRAPH_NODE';
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
