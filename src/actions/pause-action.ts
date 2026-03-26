import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const pauseActionHandler: ActionHandler = {
  actionType: "pause",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "pause") throw new Error("Wrong handler");
    const start = Date.now();

    ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
      type: "pause",
      duration_ms: action.duration_ms,
    });

    ctx.logger.info(
      { duration_ms: action.duration_ms },
      `Director: pause ${action.duration_ms}ms`,
    );

    await new Promise((r) => setTimeout(r, action.duration_ms));

    return { success: true, duration_ms: Date.now() - start };
  },
};
