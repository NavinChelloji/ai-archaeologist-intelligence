import { Inject, Injectable } from "@nestjs/common";
import OpenAI from "openai";
import { AppError } from "@aca/contracts";
import { APP_CONFIG } from "../../../config/config.module";
import type { AiEnv } from "../../../config/env";
import { estimateTokens } from "../../retrieval/chunking/token-estimate";
import type { PromptMessage } from "../prompt-builder";
import type { LlmProvider, LlmStreamResult, LlmUsage } from "./llm-provider";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const TEMPERATURE = 0.1; // factual retrieval task, not a creative one (LLM_PROMPTING.md "Model Configuration")
const TOP_P = 1;

function toOpenAiMessages(messages: PromptMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function toLlmError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AppError("LLM_TIMEOUT", "The language model took too long to respond.", { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AppError("LLM_RATE_LIMITED", "The language model provider is rate-limiting requests.", { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return new AppError("LLM_PROVIDER_ERROR", "The language model provider returned an error.", { cause: err });
  }
  return new AppError("LLM_PROVIDER_ERROR", "The language model provider could not be reached.", { cause: err });
}

/**
 * Groq adapter — Groq's chat completions API is OpenAI-compatible, so this
 * is the `openai` SDK pointed at Groq's `baseURL` rather than a bespoke
 * client (CHAT_SERVICE_PLAN.md "LLM_PROVIDER plus LLM_API_KEY replace the
 * hardcoded OPENAI_API_KEY"). `stream_options.include_usage` is requested,
 * but not every OpenAI-compatible provider honours it, so a token estimate
 * is the fallback rather than a missing/zeroed usage record — accurate
 * accounting matters more here than exactness (CHAT_SERVICE_PLAN.md
 * "Testing": usage recorded accurately for both streamed and failed
 * requests).
 */
@Injectable()
export class GroqLlmProvider implements LlmProvider {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(@Inject(APP_CONFIG) config: AiEnv) {
    this.model = config.CHAT_MODEL;
    this.client = new OpenAI({
      apiKey: config.LLM_API_KEY,
      baseURL: GROQ_BASE_URL,
      timeout: config.LLM_REQUEST_TIMEOUT_MS,
    });
  }

  streamChatCompletion(input: { messages: PromptMessage[]; maxOutputTokens: number }): LlmStreamResult {
    const client = this.client;
    const model = this.model;

    let resolveUsage!: (usage: LlmUsage) => void;
    const usage = new Promise<LlmUsage>((resolve) => {
      resolveUsage = resolve;
    });

    async function* chunks(): AsyncGenerator<string> {
      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: string | null = null;
      let assembled = "";

      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        stream = await client.chat.completions.create({
          model,
          messages: toOpenAiMessages(input.messages),
          temperature: TEMPERATURE,
          top_p: TOP_P,
          max_tokens: input.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        });
      } catch (err) {
        resolveUsage({ promptTokens: 0, completionTokens: 0, finishReason: null });
        throw toLlmError(err);
      }

      try {
        for await (const part of stream) {
          const choice = part.choices[0];
          const delta = choice?.delta?.content ?? "";
          if (delta) {
            assembled += delta;
            yield delta;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (part.usage) {
            promptTokens = part.usage.prompt_tokens;
            completionTokens = part.usage.completion_tokens;
          }
        }
      } catch (err) {
        resolveUsage({ promptTokens, completionTokens, finishReason });
        throw toLlmError(err);
      }

      if (completionTokens === 0) completionTokens = estimateTokens(assembled);
      if (promptTokens === 0) promptTokens = estimateTokens(input.messages.map((m) => m.content).join("\n"));
      resolveUsage({ promptTokens, completionTokens, finishReason });
    }

    return { chunks: chunks(), usage };
  }
}
