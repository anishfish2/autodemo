import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";

export const uploadFileHandler: ActionHandler = {
  actionType: "upload_file",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "upload_file") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      const resolved = await ctx.targetResolver.waitForTarget(
        action.target,
        ctx.page,
        action.timeout_ms,
      );

      if (resolved.kind !== "locator") {
        return {
          success: false,
          duration_ms: Date.now() - start,
          error: {
            code: "UPLOAD_FAILED",
            message: "Cannot upload to coordinate target — use a selector for the file input",
          },
        };
      }

      await resolved.locator.setInputFiles(action.file_path);
      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "UPLOAD_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
