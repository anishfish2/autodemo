import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";

export interface LlmCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class LlmClient {
  private client: Anthropic;

  constructor(
    private model: string,
    private logger: Logger,
  ) {
    this.client = new Anthropic();
  }

  async generatePlan(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<LlmCallResult> {
    const startMs = Date.now();

    this.logger.debug(
      { model: this.model, messageCount: messages.length },
      "Sending request to Claude",
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
    });

    const latencyMs = Date.now() - startMs;

    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );
    const content = textBlocks.map((b) => b.text).join("");

    this.logger.debug(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
      },
      "Claude response received",
    );

    return {
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs,
    };
  }
}
