import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";
import { AssertionEngine } from "../assertion/assertion-engine.js";
import { TargetResolver } from "../target/target-resolver.js";

export const assertHandler: ActionHandler = {
  actionType: "assert",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "assert") throw new Error("Wrong handler");
    const start = Date.now();

    const engine = new AssertionEngine(ctx.targetResolver as TargetResolver);
    const result = await engine.evaluate(action.assertion, ctx.page);

    if (result.passed) {
      ctx.logger.info(`Assert PASSED: ${result.message}`);
      return { success: true, duration_ms: Date.now() - start };
    }

    const failMessage = action.message
      ? `${action.message}: ${result.message}`
      : result.message;

    ctx.logger.warn(`Assert FAILED: ${failMessage}`);
    return {
      success: false,
      duration_ms: Date.now() - start,
      error: {
        code: "ASSERTION_FAILED",
        message: failMessage,
      },
    };
  },
};
