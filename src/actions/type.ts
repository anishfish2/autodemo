import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const typeHandler: ActionHandler = {
  actionType: "type",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "type") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      const resolved = await ctx.targetResolver.waitForTarget(
        action.target,
        ctx.page,
        action.timeout_ms,
      );

      // Animate real system cursor before typing
      if (ctx.cursorAnimator) {
        await ctx.cursorAnimator.moveToElement(resolved, ctx.page);
      }

      if (resolved.kind === "coordinates") {
        await ctx.page.mouse.click(resolved.x, resolved.y);
        if (action.clear_first) {
          await ctx.page.keyboard.press("Meta+a");
          await ctx.page.keyboard.press("Backspace");
        }
        await ctx.page.keyboard.type(action.text, {
          delay: action.delay_ms,
        });
      } else {
        if (action.clear_first) {
          await resolved.locator.fill("");
        }
        if (action.delay_ms > 0) {
          await resolved.locator.pressSequentially(action.text, {
            delay: action.delay_ms,
          });
        } else {
          await resolved.locator.fill(action.text);
        }
      }

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "TYPE_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
