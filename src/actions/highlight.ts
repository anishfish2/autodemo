import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const highlightHandler: ActionHandler = {
  actionType: "highlight",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "highlight") throw new Error("Wrong handler");
    const start = Date.now();

    try {
      const resolved = ctx.targetResolver.resolve(action.target, ctx.page);
      let x = 0,
        y = 0,
        w = 100,
        h = 50;

      if (resolved.kind === "coordinates") {
        x = resolved.x - 50;
        y = resolved.y - 25;
      } else {
        const box = await resolved.locator.boundingBox();
        if (box) {
          x = Math.round(box.x);
          y = Math.round(box.y);
          w = Math.round(box.width);
          h = Math.round(box.height);
        }
      }

      ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
        type: "highlight",
        x,
        y,
        width: w,
        height: h,
        style: action.style,
        color: action.color,
        duration_ms: action.duration_ms,
      });

      ctx.logger.info(
        { x, y, w, h, style: action.style },
        `Director: highlight element`,
      );

      // Hold for the highlight duration
      await new Promise((r) => setTimeout(r, action.duration_ms));

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "HIGHLIGHT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
