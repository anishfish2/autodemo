import type { Action } from "../schema/action.js";
import type { ExecutionContext } from "../executor/executor.js";

export interface ActionResult {
  success: boolean;
  duration_ms: number;
  extracted?: Record<string, string>;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}

export interface ActionHandler<T extends Action = Action> {
  readonly actionType: T["action"];
  execute(action: T, ctx: ExecutionContext): Promise<ActionResult>;
}
