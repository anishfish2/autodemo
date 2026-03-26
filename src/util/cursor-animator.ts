import type { Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedTarget } from "../target/target-resolver.js";
import type { EventLogger } from "../recording/event-logger.js";

const execFileAsync = promisify(execFile);

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CursorAnimator {
  private currentX = 0;
  private currentY = 0;
  private durationMs: number;
  private headless: boolean;
  eventLogger?: EventLogger;

  constructor(durationMs = 600, headless = false) {
    this.durationMs = durationMs;
    this.headless = headless;
  }

  async init(): Promise<void> {
    // No init needed in headless mode — coordinates are viewport-relative
    if (this.headless) return;

    // In visible mode, we still don't need window offsets since
    // we now use Playwright video recording instead of screen capture
  }

  async moveToElement(
    resolved: ResolvedTarget,
    page: Page,
    durationMs?: number,
  ): Promise<void> {
    const coords = await this.resolveViewportCoordinates(resolved, page);
    if (!coords) return;

    await this.animateTo(coords.x, coords.y, durationMs ?? this.durationMs);
  }

  private async resolveViewportCoordinates(
    resolved: ResolvedTarget,
    page: Page,
  ): Promise<{ x: number; y: number } | null> {
    if (resolved.kind === "coordinates") {
      return { x: resolved.x, y: resolved.y };
    }

    const box = await resolved.locator.boundingBox();
    if (!box) return null;

    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }

  private async animateTo(
    targetX: number,
    targetY: number,
    durationMs: number,
  ): Promise<void> {
    const steps = this.headless ? 10 : 20;
    const stepDelay = durationMs / steps;
    const startX = this.currentX;
    const startY = this.currentY;

    for (let i = 1; i <= steps; i++) {
      const t = easeInOutCubic(i / steps);
      const x = Math.round(startX + (targetX - startX) * t);
      const y = Math.round(startY + (targetY - startY) * t);

      // Log position for post-processing cursor overlay
      this.eventLogger?.logCursorPosition(x, y);

      // Only warp real system cursor in visible mode
      if (!this.headless) {
        await execFileAsync("osascript", [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('CoreGraphics'); $.CGWarpMouseCursorPosition($.CGPointMake(${x}, ${y}))`,
        ]);
      }

      if (i < steps) {
        await sleep(stepDelay);
      }
    }

    this.currentX = targetX;
    this.currentY = targetY;
  }
}
