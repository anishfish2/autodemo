import type { ActionHandler, ActionResult } from "./types.js";
import type { ExecutionContext } from "../executor/executor.js";
import { sleep } from "../executor/retry.js";

export const waitForHandler: ActionHandler = {
  actionType: "wait_for",

  async execute(action, ctx: ExecutionContext): Promise<ActionResult> {
    if (action.action !== "wait_for") throw new Error("Wrong handler");
    const start = Date.now();
    try {
      const { condition } = action;

      switch (condition.type) {
        case "selector": {
          const resolved = ctx.targetResolver.resolve(condition.target, ctx.page);
          if (resolved.kind === "locator") {
            await resolved.locator.waitFor({
              state: condition.state,
              timeout: action.timeout_ms,
            });
          }
          break;
        }
        case "url": {
          await ctx.page.waitForURL(
            (url) => {
              const urlStr = url.toString();
              switch (condition.operator) {
                case "equals":
                  return urlStr === condition.value;
                case "contains":
                  return urlStr.includes(condition.value);
                case "matches":
                  return new RegExp(condition.value).test(urlStr);
              }
            },
            { timeout: action.timeout_ms },
          );
          break;
        }
        case "delay_ms": {
          await sleep(condition.value);
          break;
        }
        case "navigation": {
          await ctx.page.waitForNavigation({ timeout: action.timeout_ms });
          break;
        }
      }

      return { success: true, duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration_ms: Date.now() - start,
        error: {
          code: "WAIT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
