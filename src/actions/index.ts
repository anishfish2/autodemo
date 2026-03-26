import type { ActionHandler } from "./types.js";
import { openUrlHandler } from "./open-url.js";
import { clickHandler } from "./click.js";
import { typeHandler } from "./type.js";
import { pressKeysHandler } from "./press-keys.js";
import { doneHandler } from "./done.js";
import { waitForHandler } from "./wait-for.js";
import { scrollHandler } from "./scroll.js";
import { extractTextHandler } from "./extract-text.js";
import { uploadFileHandler } from "./upload-file.js";
import { assertHandler } from "./assert.js";
import { openAppHandler } from "./open-app.js";
import { focusAppHandler } from "./focus-app.js";
import { zoomToHandler } from "./zoom-to.js";
import { zoomOutHandler } from "./zoom-out.js";
import { highlightHandler } from "./highlight.js";
import { calloutHandler } from "./callout.js";
import { pauseActionHandler } from "./pause-action.js";
import { transitionHandler } from "./transition.js";
import { setSpeedHandler } from "./set-speed.js";

const handlers: ActionHandler[] = [
  openUrlHandler,
  clickHandler,
  typeHandler,
  pressKeysHandler,
  doneHandler,
  waitForHandler,
  scrollHandler,
  extractTextHandler,
  uploadFileHandler,
  assertHandler,
  openAppHandler,
  focusAppHandler,
  zoomToHandler,
  zoomOutHandler,
  highlightHandler,
  calloutHandler,
  pauseActionHandler,
  transitionHandler,
  setSpeedHandler,
];

const registry = new Map<string, ActionHandler>();
for (const handler of handlers) {
  registry.set(handler.actionType, handler);
}

export function getActionHandler(actionType: string): ActionHandler {
  const handler = registry.get(actionType);
  if (!handler) {
    throw new Error(
      `No handler registered for action type "${actionType}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return handler;
}

export function registerActionHandler(handler: ActionHandler): void {
  registry.set(handler.actionType, handler);
}
