import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const doneHandler: ActionHandler = {
  actionType: "done",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "done") throw new Error("Wrong handler");
    if (action.message) {
      ctx.logger.info(action.message);
    }
    return { success: true, duration_ms: 0 };
  },
};
