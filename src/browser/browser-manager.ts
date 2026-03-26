import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  slowMo?: number;
  recordVideoDir?: string;
}

export interface ScreenInfo {
  logicalWidth: number;
  logicalHeight: number;
  scaleFactor: number;
  physicalWidth: number;
  physicalHeight: number;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  screenInfo: ScreenInfo | null = null;

  async launch(
    options: BrowserOptions,
  ): Promise<{ context: BrowserContext; page: Page }> {
    // Detect actual screen dimensions before launching
    this.screenInfo = await this.detectScreenInfo();

    this.browser = await chromium.launch({
      channel: "chrome",
      headless: options.headless,
      slowMo: options.slowMo,
      args: [
        "--start-fullscreen",
        "--disable-infobars",
      ],
    });

    // In headless mode: use explicit 1920x1080 viewport for crisp full HD
    // In visible mode: use null viewport to fill the window
    const useViewport = options.headless
      ? { width: 1920, height: 1080 }
      : null;
    const videoSize = options.headless
      ? { width: 1920, height: 1080 }
      : { width: this.screenInfo.logicalWidth, height: this.screenInfo.logicalHeight };

    this.context = await this.browser.newContext({
      viewport: useViewport,
      screen: videoSize,
      ...(options.recordVideoDir
        ? {
            recordVideo: {
              dir: options.recordVideoDir,
              size: videoSize,
            },
          }
        : {}),
    });

    this.page = await this.context.newPage();

    if (!options.headless) {
      await this.maximizeWindow();
    }

    return { context: this.context, page: this.page };
  }

  private async detectScreenInfo(): Promise<ScreenInfo> {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const f = s.frame; const b = s.backingScaleFactor; JSON.stringify({w:f.size.width, h:f.size.height, s:b})`,
      ]);
      const parsed = JSON.parse(stdout.trim());
      return {
        logicalWidth: Math.round(parsed.w),
        logicalHeight: Math.round(parsed.h),
        scaleFactor: parsed.s,
        physicalWidth: Math.round(parsed.w * parsed.s),
        physicalHeight: Math.round(parsed.h * parsed.s),
      };
    } catch {
      return {
        logicalWidth: 1920,
        logicalHeight: 1080,
        scaleFactor: 1,
        physicalWidth: 1920,
        physicalHeight: 1080,
      };
    }
  }

  private async maximizeWindow(): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 500));
      // Enter macOS native fullscreen (green button) via System Events
      await execFileAsync("osascript", [
        "-e",
        `tell application "Google Chrome" to activate
        delay 0.3
        tell application "System Events" to tell process "Google Chrome"
          set frontmost to true
          -- Check if already fullscreen, if not enter it
          if (value of attribute "AXFullScreen" of window 1) is false then
            set value of attribute "AXFullScreen" of window 1 to true
          end if
        end tell`,
      ]);
      // Give macOS fullscreen animation time to complete
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // Fallback: just set bounds to fill screen
      try {
        const w = this.screenInfo?.logicalWidth ?? 1920;
        const h = this.screenInfo?.logicalHeight ?? 1080;
        await execFileAsync("osascript", [
          "-e",
          `tell application "Google Chrome"
            set bounds of front window to {0, 0, ${w}, ${h}}
          end tell`,
        ]);
      } catch {
        // Non-critical
      }
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not launched — call launch() first");
    }
    return this.page;
  }
}
