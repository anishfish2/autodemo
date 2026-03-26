import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const pressKeysHandler: ActionHandler = {
  actionType: "press_keys",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "press_keys") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      if (action.target) {
        const resolved = await ctx.targetResolver.waitForTarget(
          action.target,
          ctx.page,
          action.timeout_ms,
        );

        // Animate real system cursor to target
        if (ctx.cursorAnimator) {
          await ctx.cursorAnimator.moveToElement(resolved, ctx.page);
        }

        if (resolved.kind === "locator") {
          await resolved.locator.press(action.keys, {
            timeout: action.timeout_ms,
          });
        } else {
          await ctx.page.mouse.click(resolved.x, resolved.y);
          await ctx.page.keyboard.press(action.keys);
        }
      } else {
        await ctx.page.keyboard.press(action.keys);
      }

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "PRESS_KEYS_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
