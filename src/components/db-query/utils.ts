import {DEFAULT_MAX_READ_ROWS_FOR_AI} from './constant';
import {DbQueryConfig, IDataSetStore} from './types';

/**
 * Build the message the dataset tools hand back to the AI agent.
 *
 * Mirrors the v2 GetDataAsDatasetTool.getValue contract: the AI is told
 * the dataset was produced and rendered for the user, and given the
 * dataset ID — nothing more. It deliberately does NOT expose a row count
 * or result rows by default, because the AI's job is to generate the
 * query, not to read the data (the UI renders the grid from the ID).
 *
 * Result rows are appended ONLY when the consumer opts in via
 * `config.readAccessForAI`, capped at `config.maxRowsForAI`
 * (default {@link DEFAULT_MAX_READ_ROWS_FOR_AI}). The read is advisory:
 * a failure here never fails the tool.
 */
export async function buildDatasetReadout(args: {
  datasetId: string;
  verb: 'generated' | 'updated';
  store?: IDataSetStore;
  config?: DbQueryConfig;
}): Promise<string> {
  const {datasetId, verb, store, config} = args;
  if (!datasetId) {
    return `Could not ${verb === 'generated' ? 'generate' : 'update'} the dataset for that request.`;
  }
  // Neutral, fact-only readout (parity with the LangGraph get-data result).
  // The datasetId is included so a LATER turn can pass it to ask-about-dataset
  // for a follow-up question. Deliberately no "do not call any tool again"
  // imperative here: this string is persisted into the Memory thread, and a
  // standing prohibition bleeds into the next turn and suppresses the
  // ask-about-dataset call (the model answers from history and guesses).
  // Within-turn re-looping is already bounded structurally by the agent's
  // maxSteps cap + the per-turn "call one tool once, then reply" instruction,
  // neither of which persists across turns.
  const base = `Dataset ${verb} and has been rendered for the user (dataset ID ${datasetId}). Tell the user it is done in one short sentence.`;
  if (!config?.readAccessForAI || !store) {
    return base;
  }
  try {
    const max = config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI;
    const rows = await store.getData(datasetId, max);
    if (!rows?.length) {
      return base;
    }
    return `${base} First ${max} results from the dataset are: ${JSON.stringify(rows)}`;
  } catch {
    return base;
  }
}
