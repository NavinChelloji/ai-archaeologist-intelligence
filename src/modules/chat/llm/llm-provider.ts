import type { PromptMessage } from "../prompt-builder";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
}

export interface LlmStreamResult {
  /** Text deltas, in emission order. */
  chunks: AsyncIterable<string>;
  /** Resolves once the stream has fully drained — real usage when the provider reports it, an `estimateTokens` fallback otherwise. */
  usage: Promise<LlmUsage>;
}

/**
 * Provider-agnostic boundary behind `LLM_PROVIDER` (CHAT_SERVICE_PLAN.md
 * "Environment Variables", LLM_PROMPTING.md "Model Configuration"). Only a
 * Groq adapter exists today — the interface is what makes `ChatService`
 * testable with a fake and swappable for another OpenAI-compatible or
 * native provider later without touching callers.
 */
export interface LlmProvider {
  readonly model: string;
  streamChatCompletion(input: { messages: PromptMessage[]; maxOutputTokens: number }): LlmStreamResult;
}

export const LLM_PROVIDER_TOKEN = Symbol("LLM_PROVIDER_TOKEN");
