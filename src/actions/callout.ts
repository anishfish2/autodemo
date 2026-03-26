import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const calloutHandler: ActionHandler = {
  actionType: "callout",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "callout") throw new Error("Wrong handler");
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
          // Position text relative to element based on position setting
          switch (action.position) {
            case "top":
              x = Math.round(box.x + box.width / 2);
              y = Math.round(box.y - 30);
              break;
            case "bottom":
              x = Math.round(box.x + box.width / 2);
              y = Math.round(box.y + box.height + 10);
              break;
            case "left":
              x = Math.round(box.x - 10);
              y = Math.round(box.y + box.height / 2);
              break;
            case "right":
              x = Math.round(box.x + box.width + 10);
              y = Math.round(box.y + box.height / 2);
              break;
          }
        }
      }

      ctx.cursorAnimator?.eventLogger?.logDirectorEvent({
        type: "callout",
        x,
        y,
        text: action.text,
        position: action.position,
        duration_ms: action.duration_ms,
      });

      ctx.logger.info(
        { text: action.text, position: action.position },
        `Director: callout "${action.text}"`,
      );

      await new Promise((r) => setTimeout(r, action.duration_ms));

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "CALLOUT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
