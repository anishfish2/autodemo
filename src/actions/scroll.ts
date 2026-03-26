import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const scrollHandler: ActionHandler = {
  actionType: "scroll",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "scroll") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      let deltaX = 0;
      let deltaY = 0;

      switch (action.direction) {
        case "down":
          deltaY = action.amount;
          break;
        case "up":
          deltaY = -action.amount;
          break;
        case "right":
          deltaX = action.amount;
          break;
        case "left":
          deltaX = -action.amount;
          break;
      }

      if (action.target) {
        const resolved = await ctx.targetResolver.waitForTarget(
          action.target,
          ctx.page,
          action.timeout_ms,
        );

        // Animate real system cursor to scroll target
        if (ctx.cursorAnimator) {
          await ctx.cursorAnimator.moveToElement(resolved, ctx.page);
        }

        if (resolved.kind === "locator") {
          await resolved.locator.evaluate(
            (el, { dx, dy }) => el.scrollBy(dx, dy),
            { dx: deltaX, dy: deltaY },
          );
        } else {
          await ctx.page.mouse.move(resolved.x, resolved.y);
          await ctx.page.mouse.wheel(deltaX, deltaY);
        }
      } else {
        await ctx.page.mouse.wheel(deltaX, deltaY);
      }

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "SCROLL_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
