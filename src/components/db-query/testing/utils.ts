import {AnyObject} from '@loopback/repository';

export function generateMarkdownTable(data: AnyObject[]) {
  if (!data || data.length === 0) return '';

  // Extract headers (keys of the first object)
  const headers = Object.keys(data[0]);

  // Table header row
  const table = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  // Table rows
  data.forEach(row => {
    const values = headers.map(h => row[h] ?? ''); // keep empty if missing
    table.push(`| ${values.join(' | ')} |`);
  });

  return table.join('\n');
}

export function getModelNameFromEnv(): string {
  switch (process.env.LLM_PROVIDER) {
    case 'bedrock':
      return process.env.CLAUDE_THINKING === 'true'
        ? `${(process.env.BEDROCK_MODEL ?? '').slice(0, 20)}-thinking`
        : (process.env.BEDROCK_MODEL ?? 'Unknown Bedrock Model').slice(0, 20);
    case 'openai':
      return process.env.OPENAI_MODEL ?? 'Unknown OpenAI Model';
    case 'groq':
      return process.env.GROQ_MODEL ?? 'Unknown Groq Model';
    case 'cerebras':
      return process.env.CEREBRAS_MODEL ?? 'Unknown Cerebras Model';
    case 'ollama':
      return process.env.OLLAMA_MODEL ?? 'Unknown Ollama Model';
    case 'google':
      return process.env.GOOGLE_CHAT_MODEL ?? 'Unknown Google Model';
    case 'anthropic':
      return process.env.CLAUDE_MODEL ?? 'Unknown Claude Model';
    case 'advanced':
      return 'combined';
    default:
      return 'Unknown Model';
  }
}
