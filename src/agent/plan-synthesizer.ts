import { z } from "zod";
import { Action } from "../schema/action.js";
import { Plan } from "../schema/plan.js";
import type { Plan as PlanType } from "../schema/plan.js";
import type { Action as ActionType } from "../schema/action.js";
import type { LlmPlanResponse } from "./agent-types.js";
import type { Logger } from "pino";

const LlmResponseSchema = z.object({
  thinking: z.string(),
  status: z.enum(["continue", "task_complete", "task_impossible"]),
  steps: z.array(z.unknown()).default([]),
  completionMessage: z.string().optional(),
  impossibleReason: z.string().optional(),
});

export class PlanSynthesizer {
  constructor(private logger: Logger) {}

  parseResponse(raw: string): LlmPlanResponse {
    const jsonStr = this.extractJson(raw);
    const parsed = JSON.parse(jsonStr);
    const envelope = LlmResponseSchema.parse(parsed);

    const validatedSteps: ActionType[] = [];
    const stepErrors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < envelope.steps.length; i++) {
      const stepRaw = envelope.steps[i];
      const result = Action.safeParse(stepRaw);
      if (result.success) {
        validatedSteps.push(result.data);
      } else {
        const errorMsg = result.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ");
        stepErrors.push({ index: i, error: errorMsg });
        this.logger.warn(
          { stepIndex: i, error: errorMsg },
          "LLM generated invalid step — skipping",
        );
      }
    }

    if (stepErrors.length > 0 && validatedSteps.length === 0) {
      throw new Error(
        `All ${envelope.steps.length} steps from LLM were invalid: ${JSON.stringify(stepErrors)}`,
      );
    }

    return {
      thinking: envelope.thinking,
      status: envelope.status,
      steps: validatedSteps,
      completionMessage: envelope.completionMessage,
      impossibleReason: envelope.impossibleReason,
    };
  }

  buildChunkPlan(
    steps: ActionType[],
    taskName: string,
    iteration: number,
  ): PlanType {
    const plan = {
      metadata: {
        name: `${taskName} (chunk ${iteration})`,
        description: `Auto-generated chunk ${iteration}`,
        version: "1",
        tags: ["agent", `iteration-${iteration}`],
        timeout_ms: 60000,
        screen: { width: 1920, height: 1080 },
      },
      steps,
    };

    return Plan.parse(plan);
  }

  private extractJson(raw: string): string {
    const trimmed = raw.trim();

    // Already valid JSON
    if (trimmed.startsWith("{")) {
      return trimmed;
    }

    // JSON within markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      return fenceMatch[1].trim();
    }

    // Find first { ... } block
    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      return trimmed.slice(braceStart, braceEnd + 1);
    }

    throw new Error("Could not extract JSON from LLM response");
  }
}
