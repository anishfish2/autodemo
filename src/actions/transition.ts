import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const transitionHandler: ActionHandler = {
  actionType: "transition",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "transition") throw new Error("Wrong handler");
    const start = Date.now();

    ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
      type: "transition",
      style: action.style,
      duration_ms: action.duration_ms,
    });

    ctx.logger.info(
      { style: action.style, duration_ms: action.duration_ms },
      `Director: ${action.style} transition`,
    );

    // Sleep for transition duration
    await new Promise((r) => setTimeout(r, action.duration_ms));

    return { success: true, duration_ms: Date.now() - start };
  },
};
