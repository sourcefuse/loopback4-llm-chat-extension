import {z} from 'zod';

/**
 * Shared contract carried out of generate-checklist, THROUGH verify-checklist,
 * and into sql-and-validate. Defined once so the generate→verify `.then()` link
 * cannot drift.
 */
export const checklistStateSchema = z.object({
  prompt: z.string(),
  tables: z.array(z.string()),
  checklist: z.string(),
  attempts: z.number(),
  cached: z.boolean().optional(),
  datasetId: z.string().optional(),
  sql: z.string().optional(),
  unanswerable: z.boolean().optional(),
  replyToUser: z.string().optional(),
  sampleSql: z.string().optional(),
  samplePrompt: z.string().optional(),
});

// Below this table count the planning value of a checklist doesn't pay for the
// extra LLM round-trip (v2 generate-checklist.node / verify-checklist.node
// `tableCount <= 2` guard). Shared by both the generate and verify passes.
export const CHECKLIST_MIN_TABLES = 2;

/**
 * The domain-rule candidate set for a query: the host-supplied GlobalContext
 * rules plus the per-table `context` rules of the selected tables, alongside
 * the schema DDL used as grounding for the relevance LLM call. Mirrors v2
 * `[...checks, ...schemaHelper.getTablesContext(schema)]`.
 */
export interface DomainRuleContext {
  rules: string[];
  schemaText: string;
}
