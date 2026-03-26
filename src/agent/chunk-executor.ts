import type { ExecutionContext, StepLog } from "../executor/executor.js";
import type { Plan } from "../schema/plan.js";
import type { ChunkResult } from "./agent-types.js";
import { executeStep } from "../executor/executor.js";
import { AssertionEngine } from "../assertion/assertion-engine.js";
import { TargetResolver } from "../target/target-resolver.js";

export async function executeChunk(
  plan: Plan,
  ctx: ExecutionContext,
  globalStepOffset: number,
): Promise<ChunkResult> {
  const assertionEngine = new AssertionEngine(
    ctx.targetResolver as TargetResolver,
  );
  const stepLogs: StepLog[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    ctx.stepIndex = globalStepOffset + i;

    if (ctx.aborted) break;

    let stepLog: StepLog;
    try {
      stepLog = await executeStep(step, ctx, assertionEngine);
    } catch (err) {
      // Catch fatal errors (page crashed, browser closed, etc.)
      // Return a clean failure instead of letting it propagate
      const errorMsg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { step: step.action, error: errorMsg },
        "Step threw fatal error",
      );
      stepLog = {
        step_index: ctx.stepIndex,
        step_id: step.id ?? `step_${ctx.stepIndex}_${step.action}`,
        action: step.action,
        description: step.description,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 0,
        attempt: 1,
        max_attempts: step.retry.max_attempts,
        result: "failure",
        pre_state: null,
        post_state: null,
        assertions: [],
        error: { code: "FATAL", message: errorMsg },
      };
    }

    stepLogs.push(stepLog);
    await ctx.traceStore.writeStepLog(stepLog).catch(() => {});

    if (stepLog.result === "failure") {
      return {
        steps: stepLogs,
        result: "failure",
        failedAtStep: ctx.stepIndex,
        errorSummary: stepLog.error?.message ?? "Unknown error",
      };
    }
  }

  return {
    steps: stepLogs,
    result: "success",
  };
}
