/**
 * @mastra/core@~1.36.x publishes test-utils/llm-mock.js (+ .cjs) but
 * forgets to ship the corresponding .d.ts. This ambient declaration
 * mirrors the runtime export so the integration tests compile under
 * lb-tsc. Drop the file once Mastra ships the missing types upstream.
 */
declare module '@mastra/core/test-utils/llm-mock' {
  /**
   * Factory the package actually ships. Accepts text + (optional) version
   * and returns a fully-formed mock that satisfies the Mastra Agent
   * model contract. v3.x ships v1 and v2 variants; default 'v2' matches
   * @ai-sdk/* v3 provider output the rest of the repo uses.
   */
  export function createMockModel(opts: {
    mockText: string | object;
    version?: 'v1' | 'v2';
    objectGenerationMode?: 'json';
    spyGenerate?: (props: unknown) => void;
    spyStream?: (props: unknown) => void;
  }): unknown;
}
