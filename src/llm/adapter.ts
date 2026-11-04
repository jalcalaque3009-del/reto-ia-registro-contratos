export interface LlmAdapter {
  send(messages: unknown[], tools: unknown[], maxTokens: number): Promise<{ message: {role:string;content?:string|null;tool_calls?:Array<{id:string;type:string;function:{name:string;arguments:string}}>}; usage: number }>;
}
