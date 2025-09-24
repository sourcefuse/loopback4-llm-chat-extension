import {PromptTemplate} from '@langchain/core/prompts';
import {AnyObject} from '@loopback/repository';

export class PromptStore {
  store: Record<string, PromptTemplate | string> = {};
  async get(key: string, params: AnyObject): Promise<string> {
    const prompt = this.store[key];
    if (!prompt) {
      throw new Error(`Prompt with key ${key} not found`);
    }
    if (typeof prompt === 'string') {
      return prompt;
    }
    return prompt.format(params);
  }
  async set(key: string, prompt: PromptTemplate | string) {
    this.store[key] = prompt;
  }
}
