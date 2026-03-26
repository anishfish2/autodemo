import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const clickHandler: ActionHandler = {
  actionType: "click",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "click") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      const resolved = await ctx.targetResolver.waitForTarget(
        action.target,
        ctx.page,
        action.timeout_ms,
      );

      // Animate real system cursor before clicking
      if (ctx.cursorAnimator) {
        await ctx.cursorAnimator.moveToElement(resolved, ctx.page);
      }

      if (resolved.kind === "coordinates") {
        // Log click event for recording post-processing
        ctx.cursorAnimator?.eventLogger?.logClick(resolved.x, resolved.y, action.button);
        await ctx.page.mouse.click(resolved.x, resolved.y, {
          button: action.button,
          clickCount: action.click_count,
        });
      } else {
        // Log click at element center for recording
        const box = await resolved.locator.boundingBox();
        if (box && ctx.cursorAnimator?.eventLogger) {
          ctx.cursorAnimator.eventLogger.logClick(
            Math.round(box.x + box.width / 2),
            Math.round(box.y + box.height / 2),
            action.button,
          );
        }
        await resolved.locator.click({
          button: action.button,
          clickCount: action.click_count,
          modifiers: action.modifiers.length > 0 ? action.modifiers : undefined,
          timeout: action.timeout_ms,
        });
      }

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "CLICK_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
