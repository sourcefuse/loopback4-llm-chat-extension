import {Context} from '@loopback/core';
import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {Agent} from '@mastra/core/agent';
import {LibSQLStore} from '@mastra/libsql';
import {Memory} from '@mastra/memory';
// See workflow-runner-agent.integration.ts for why the .d.ts is shimmed in
// mastra-test-utils.d.ts — the package ships the JS but forgets the types.
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import {InProcessRunRegistry} from '../../mastra/bridge/run-registry';
import {WorkflowRunner} from '../../mastra/bridge/workflow-runner';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {UsageAccumulator} from '../../services/usage-accumulator.service';

// The registered chatAgent reads no env here (its model is a static mock),
// but set defensively as the sibling integration test does.
process.env.MASTRA_DEFAULT_CHAT_MODEL ??= 'mock/test-model';

/**
 * Integration: the file-upload (summariseFile) path of WorkflowRunner.run().
 *
 * Drives the PUBLIC run(query, files, abort) surface — no sinon stubs of the
 * private summariseAndMergeFiles / summariseFile. A capturing mock
 * LanguageModelV2 is wired as the runner's `chatLlm` ctor arg
 * (workflow-runner.ts:253) — resolveFileSummaryModelConfig() returns chatLlm,
 * resolveModelConfig passes a direct V2 instance through unchanged, and
 * isAiSdkLanguageModel accepts specificationVersion === 'v2'. So the AI-SDK
 * `generateText` call that summarises the file lands on this mock's
 * doGenerate, where we capture the converted V2 prompt.
 *
 * The registered chatAgent uses a SEPARATE createMockModel with a spyStream
 * hook so we can observe the merged `[Attached file "..."]` summary in the
 * chat agent's input without coupling to its output.
 */
describe('WorkflowRunner File Summarise Integration', () => {
  const requesterResourceId = 'tenant-integration:user-integration';
  let storage: LibSQLStore;
  let mastra: Mastra;
  let runner: WorkflowRunner;
  let usage: UsageAccumulator;

  // Captured by the file-summary mock's doGenerate (the AI-SDK V2 prompt).
  let capturedFilePrompt: V2Prompt | undefined;
  // Captured by the chat-agent mock's spyStream (the merged augmented query).
  let capturedChatStream: unknown;

  beforeEach(() => {
    capturedFilePrompt = undefined;
    capturedChatStream = undefined;

    storage = new LibSQLStore({id: 'file-summarise', url: ':memory:'});
    const memory = new Memory({
      storage,
      vector: false,
      options: {
        lastMessages: 20,
        semanticRecall: false,
        workingMemory: {enabled: false},
        generateTitle: false,
      },
    });
    const chatAgent = new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: 'Test agent',
      // spyStream captures the prompt the chat agent receives so we can assert
      // the merged file summary reached it (assertion 4).
      model: createMockModel({
        mockText: 'Hello world',
        version: 'v2',
        spyStream: (p: unknown) => {
          capturedChatStream = p;
        },
      }) as never,
      tools: {},
      memory,
    });
    mastra = new Mastra({
      agents: {chatAgent},
      workflows: {},
      storage,
    });
    usage = new UsageAccumulator();
    runner = new WorkflowRunner(
      new Context('file-summarise'),
      mastra,
      // chatLlm — the capturing file-summary model.
      makeCapturingFileModel(opts => {
        capturedFilePrompt = opts.prompt as V2Prompt;
      }) as never,
      new InProcessRunRegistry(),
      requesterResourceId,
      undefined,
      usage,
    );
  });

  async function collect(
    iter: AsyncIterable<LLMStreamEvent>,
  ): Promise<LLMStreamEvent[]> {
    const out: LLMStreamEvent[] = [];
    for await (const event of iter) out.push(event);
    return out;
  }

  function buildFile(originalname: string): Express.Multer.File {
    const buffer = Buffer.from('%PDF-1.4 test');
    return {
      fieldname: 'file',
      originalname,
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
      stream: undefined as never,
      destination: '',
      filename: originalname,
      path: '',
    };
  }

  it('summarises an uploaded file through run(): sends a sanitised V2 file part and merges the summary into the chat input', async () => {
    const file = buildFile('Q3 Report!.pdf');

    const events = await collect(
      runner.run('summarise this', [file], new AbortController().signal),
    );

    // The summariseFile generateText call must have hit the capturing model.
    expect(capturedFilePrompt).to.not.be.undefined();
    const prompt = capturedFilePrompt!;

    // Assertion 3: a system message instructing summarisation.
    const systemMsg = prompt.find(m => m.role === 'system');
    expect(systemMsg).to.not.be.undefined();
    expect(systemMsg!.content as string).to.match(/Summarise/);

    // Locate the user message's file part. AI-SDK V2 file parts live in the
    // user message content array as {type:'file', filename, data, mediaType}
    // (LanguageModelV2FilePart — @ai-sdk/provider).
    const userMsg = prompt.find(m => m.role === 'user');
    expect(userMsg).to.not.be.undefined();
    const userContent = userMsg!.content as V2UserPart[];
    const filePart = userContent.find(p => p.type === 'file');
    expect(filePart).to.not.be.undefined();

    // Assertion 1a: mediaType carried through unchanged.
    expect(filePart!.mediaType).to.equal('application/pdf');

    // Assertion 1b (the load-bearing one): the filename is the SANITISED name.
    // 'Q3 Report!.pdf' -> drop ext -> 'Q3 Report!' -> strip '!' -> 'Q3 Report'.
    // Proves sanitizeFilenameForAwsConverse is wired into the real path.
    expect(filePart!.filename).to.equal('Q3 Report');

    // Assertion 2: the file part data is the uploaded buffer's bytes. AI-SDK
    // normalises the Buffer to a Uint8Array, so compare decoded bytes.
    expect(Buffer.from(filePart!.data as Uint8Array).toString()).to.equal(
      '%PDF-1.4 test',
    );

    // The original (un-sanitised) prompt text also reached the model.
    const textPart = userContent.find(p => p.type === 'text');
    expect(textPart!.text).to.equal('summarise this');

    // The UI gets a "Reading file" Status using the ORIGINAL name.
    const statuses = events
      .filter(e => e.type === LLMStreamEventType.Status)
      .map(e => (e as {data: string}).data);
    expect(statuses).to.containEql('Reading file: Q3 Report!.pdf');

    // Assertion 4: the chat agent's input reflects the merged summary,
    // prefixed `[Attached file "Q3 Report!.pdf"]` (original name) plus the
    // mock summary text. Observed via the chat model's spyStream capture.
    expect(capturedChatStream).to.not.be.undefined();
    // The user text the chat agent received, with JSON escaping undone, must
    // contain the merged `[Attached file "..."]` block built by
    // summariseAndMergeFiles.
    const chatInput = JSON.parse(JSON.stringify(capturedChatStream)) as {
      prompt: Array<{
        role: string;
        content: Array<{type: string; text?: string}>;
      }>;
    };
    const chatUserText = chatInput.prompt
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
    expect(chatUserText).to.match(/\[Attached file "Q3 Report!\.pdf"\]/);
    expect(chatUserText).to.match(/FILE SUMMARY/);
  });

  it('passes the prompt through unchanged when no file is attached (no summarise call)', async () => {
    await collect(
      runner.run('just a question', [], new AbortController().signal),
    );

    // summariseFile must NOT have run — no file model call.
    expect(capturedFilePrompt).to.be.undefined();

    // The chat agent received the original prompt verbatim, with no
    // `[Attached file …]` / `FILE SUMMARY` block merged in.
    expect(capturedChatStream).to.not.be.undefined();
    const chatInput = JSON.parse(JSON.stringify(capturedChatStream)) as {
      prompt: Array<{
        role: string;
        content: Array<{type: string; text?: string}>;
      }>;
    };
    const chatUserText = chatInput.prompt
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
    expect(chatUserText).to.match(/just a question/);
    expect(chatUserText).to.not.match(/Attached file/);
    expect(chatUserText).to.not.match(/FILE SUMMARY/);
  });
});

// --- AI-SDK V2 prompt shape (subset we assert against) ---------------------
type V2TextPart = {type: 'text'; text: string};
type V2FilePart = {
  type: 'file';
  filename?: string;
  data: unknown;
  mediaType: string;
};
type V2UserPart = V2TextPart | V2FilePart;
type V2Message =
  | {role: 'system'; content: string}
  | {role: 'user'; content: V2UserPart[]}
  | {role: string; content: unknown};
type V2Prompt = V2Message[];

/**
 * A minimal capturing LanguageModelV2. resolveModelConfig passes direct
 * LanguageModel instances through unchanged and isAiSdkLanguageModel accepts
 * specificationVersion 'v2', so this stands in as the runner's chatLlm and
 * receives the file-summarisation generateText() call. doGenerate records the
 * converted V2 prompt and returns a fixed summary; the return shape matches
 * @ai-sdk/provider LanguageModelV2.doGenerate (content parts + finishReason +
 * usage + warnings).
 */
function makeCapturingFileModel(capture: (opts: {prompt: unknown}) => void) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'mock-file',
    supportedUrls: {},
    async doGenerate(opts: {prompt: unknown}) {
      capture(opts);
      return {
        content: [{type: 'text' as const, text: 'FILE SUMMARY'}],
        finishReason: 'stop' as const,
        usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2},
        warnings: [],
      };
    },
    async doStream() {
      // Not exercised — summariseFile uses generateText (doGenerate only).
      throw new Error('doStream not implemented for file-summary mock');
    },
  };
}
