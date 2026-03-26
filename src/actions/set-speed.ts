import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const setSpeedHandler: ActionHandler = {
  actionType: "set_speed",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "set_speed") throw new Error("Wrong handler");
    const start = Date.now();

    ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
      type: "set_speed",
      speed: action.speed,
    });

    ctx.logger.info(
      { speed: action.speed },
      `Director: set playback speed to ${action.speed}x`,
    );

    return { success: true, duration_ms: Date.now() - start };
  },
};
