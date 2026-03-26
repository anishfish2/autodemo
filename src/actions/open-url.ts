import type { ActionHandler, ActionResult } from "./types.js";
import type { OpenUrlAction } from "../schema/action.js";
import type { ExecutionContext } from "../executor/executor.js";

export const openUrlHandler: ActionHandler<
  import("zod").infer<typeof import("../schema/action.js").OpenUrlAction>
> = {
  actionType: "open_url",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    const start = Date.now();
    try {
      await ctx.page.goto(action.url, {
        waitUntil: action.wait_until,
        timeout: action.timeout_ms,
      });
      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "NAVIGATION_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
