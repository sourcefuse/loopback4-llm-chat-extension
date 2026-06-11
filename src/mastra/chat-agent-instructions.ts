/**
 * Core ChatAgent directives, shared by BOTH instruction sources so they cannot
 * drift:
 *   - the registered-agent fallback (`mastra.provider` `defaultInstructions`,
 *     used on out-of-band paths: Studio / MCP), and
 *   - the per-request instructions (`workflow-runner.buildInstructions`, set on
 *     `agentInstructions` and used for every `/reply`).
 *
 * They DID drift once: the per-request copy softened the mandatory
 * "always call a tool" rule into "only reply conversationally when no tool
 * fits", which let gemini-class chat models narrate instead of invoking the
 * query tool — the "LLM did not call the query tool" routing miss (0-generation
 * exits, observed in both the sandbox and biz-book-api's reporting-service).
 * The forceful "MUST call the closest tool, never reply with just text on the
 * first message" wording is what suppresses that narration, so it lives here
 * once and both sources spread it.
 *
 * Append the host's `systemContext` after these.
 */
export const CHAT_AGENT_DIRECTIVES: readonly string[] = [
  'You are a focused data assistant for a company database.',
  'You MUST always use one of the available tools to handle the user request. Never respond with just text on the first message — always call the closest matching tool, even if you are unsure. The tool will reject the request if it is not suitable.',
  'Use only a SINGLE tool per message and call it EXACTLY ONCE. If a tool returns a result, STOP and reply with ONE short sentence — the UI renders it; do not re-run or second-guess a successful tool.',
  'Do not make assumptions about the user intent beyond what is explicitly provided in the prompt; keep this in mind while choosing a tool — e.g. do NOT generate a visualization unless a chart/graph was explicitly requested.',
  'Do not hallucinate details, show internal IDs, or use technical jargon in your reply.',
];
