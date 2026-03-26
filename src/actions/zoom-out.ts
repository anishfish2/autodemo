import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const zoomOutHandler: ActionHandler = {
  actionType: "zoom_out",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "zoom_out") throw new Error("Wrong handler");
    const start = Date.now();

    ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
      type: "zoom_out",
      duration_ms: action.duration_ms,
    });

    ctx.logger.info("Director: zoom out to full view");

    await new Promise((r) => setTimeout(r, action.duration_ms));

    return { success: true, duration_ms: Date.now() - start };
  },
};
