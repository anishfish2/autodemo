import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";
import { AppleScriptBridge } from "../desktop/applescript.js";

const applescript = new AppleScriptBridge();

export const focusAppHandler: ActionHandler = {
  actionType: "focus_app",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "focus_app") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      await applescript.focusApp(action.app_name);
      ctx.logger.info(`Focused app: ${action.app_name}`);
      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "FOCUS_APP_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
