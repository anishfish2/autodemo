import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const extractTextHandler: ActionHandler = {
  actionType: "extract_text",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "extract_text") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      const resolved = await ctx.targetResolver.waitForTarget(
        action.target,
        ctx.page,
        action.timeout_ms,
      );

      let text: string;
      if (resolved.kind === "locator") {
        text = (await resolved.locator.textContent()) ?? "";
      } else {
        // For coordinates, we can't extract text directly
        return {
          success: false,
          duration_ms: Date.now() - start,
          error: {
            code: "EXTRACT_FAILED",
            message: "Cannot extract text from coordinate targets — use a selector",
          },
        };
      }

      ctx.logger.info(
        { store_as: action.store_as, length: text.length },
        `Extracted text → ${action.store_as}`,
      );

      return {
        success: true,
        duration_ms: Date.now() - start,
        extracted: { [action.store_as]: text },
      };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "EXTRACT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
