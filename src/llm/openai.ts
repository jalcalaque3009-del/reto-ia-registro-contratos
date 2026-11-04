import OpenAI from 'openai';
import type { LlmAdapter } from './adapter.js';
export class OpenAiAdapter implements LlmAdapter {
  private client: OpenAI;
  constructor(private model: string) { this.client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:30000,maxRetries:0}); }
  async send(messages: unknown[], tools: unknown[], maxTokens:number) {
    const response=await this.client.chat.completions.create({model:this.model,messages:messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],tools:tools as OpenAI.Chat.Completions.ChatCompletionTool[],max_tokens:maxTokens});
    return {message:response.choices[0].message as unknown as {role:string;content?:string|null;tool_calls?:Array<{id:string;type:string;function:{name:string;arguments:string}}>},usage:response.usage?.total_tokens ?? maxTokens};
  }
}
