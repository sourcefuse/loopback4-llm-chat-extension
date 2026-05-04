import {expect} from '@loopback/testlab';
import {LangfuseCoreProvider} from '../../sub-modules/obf/langfuse/langfuse-core.provider';

describe('LangfuseCoreProvider (unit)', function () {
  const ORIGINAL_ENV = {...process.env};

  afterEach(() => {
    // Restore env vars after each test
    process.env.LANGFUSE_PUBLIC_KEY = ORIGINAL_ENV.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = ORIGINAL_ENV.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_HOST = ORIGINAL_ENV.LANGFUSE_HOST;
  });

  it('throws when LANGFUSE_PUBLIC_KEY is missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';

    const provider = new LangfuseCoreProvider();
    expect(() => provider.value()).to.throwError(
      /LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY environment variables must be set/,
    );
  });

  it('throws when LANGFUSE_SECRET_KEY is missing', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    delete process.env.LANGFUSE_SECRET_KEY;

    const provider = new LangfuseCoreProvider();
    expect(() => provider.value()).to.throwError(
      /LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY environment variables must be set/,
    );
  });

  it('throws when both keys are missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const provider = new LangfuseCoreProvider();
    expect(() => provider.value()).to.throwError(/must be set/);
  });

  it('instantiates LangfuseAPIClient when both keys are present', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    delete process.env.LANGFUSE_HOST;

    const provider = new LangfuseCoreProvider();
    const client = provider.value();

    // Should be a non-null object (LangfuseAPIClient)
    expect(client).to.not.be.null();
    expect(typeof client).to.equal('object');
  });

  it('uses LANGFUSE_HOST when provided', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_HOST = 'https://my.langfuse.server';

    const provider = new LangfuseCoreProvider();
    // Just confirm it doesn't throw — host validation is internal to the client
    const client = provider.value();
    expect(client).to.not.be.null();
  });
});
