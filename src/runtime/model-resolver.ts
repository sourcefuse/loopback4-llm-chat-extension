import type {Mastra} from '@mastra/core';
import {resolveModelConfig, type MastraModelConfig} from '@mastra/core/llm';
import type {LanguageModel} from 'ai';

// Mastra-runtime model helpers, shared by the RequestContextBuilder and the
// chat SummariseFileNode. Kept out of the node files (which mirror the thin
// LangGraph nodes) — this is Mastra-specific model-resolution glue with no
// LangGraph analog.

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike {
  return typeof value === 'object' && value !== null
    ? (value as RecordLike)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An AI-SDK v2/v3 LanguageModel instance (vs a string model id). */
export function isAiSdkLanguageModel(
  model: unknown,
): model is Exclude<LanguageModel, string> {
  const specVersion = readString(asRecord(model).specificationVersion);
  return specVersion === 'v2' || specVersion === 'v3';
}

/** Human/model-readable label for a model tier config (per-model usage bucket). */
export function modelLabel(cfg?: MastraModelConfig): string {
  if (!cfg) return 'chat';
  if (typeof cfg === 'string') return cfg;
  const o = cfg as {providerId?: string; modelId?: string};
  return o.providerId && o.modelId ? `${o.providerId}/${o.modelId}` : 'chat';
}

/** Split a `provider/model` env string into a MastraModelConfig. */
export function toModelRouterFallbackConfig(
  modelName: string,
): MastraModelConfig | undefined {
  const [providerId, ...modelParts] = modelName.split('/');
  if (!providerId || modelParts.length === 0) return undefined;
  return {providerId, modelId: modelParts.join('/')};
}

/**
 * Resolve a MastraModelConfig to a concrete AI-SDK LanguageModel (or undefined
 * if it can't be resolved to one). Passes the Mastra instance to
 * resolveModelConfig only when it exposes `listGateways` (a real Mastra), so a
 * stub in tests is ignored and a direct model instance passes through.
 */
export async function resolveAiSdkModel(
  mastra: Mastra | undefined,
  modelConfig: MastraModelConfig,
): Promise<Exclude<LanguageModel, string> | undefined> {
  const mastraForResolve =
    mastra && typeof asRecord(mastra).listGateways === 'function'
      ? mastra
      : undefined;
  const model = await resolveModelConfig(
    modelConfig,
    undefined,
    mastraForResolve,
  );
  return isAiSdkLanguageModel(model) ? model : undefined;
}
