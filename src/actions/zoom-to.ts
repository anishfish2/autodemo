import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const zoomToHandler: ActionHandler = {
  actionType: "zoom_to",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "zoom_to") throw new Error("Wrong handler");
    const start = Date.now();

    try {
      const resolved = ctx.targetResolver.resolve(action.target, ctx.page);
      let x = 0,
        y = 0;

      if (resolved.kind === "coordinates") {
        x = resolved.x;
        y = resolved.y;
      } else {
        const box = await resolved.locator.boundingBox();
        if (box) {
          x = Math.round(box.x + box.width / 2);
          y = Math.round(box.y + box.height / 2);
        }
      }

      ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
        type: "zoom_to",
        x,
        y,
        zoom_level: action.zoom_level,
        duration_ms: action.duration_ms,
      });

      ctx.logger.info(
        { x, y, zoom: action.zoom_level },
        `Director: zoom to (${x}, ${y}) at ${action.zoom_level}x`,
      );

      // Sleep for the animation duration so timing aligns with video
      await new Promise((r) => setTimeout(r, action.duration_ms));

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "ZOOM_TO_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
