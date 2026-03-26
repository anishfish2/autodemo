import type { Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface Snapshot {
  timestamp: string;
  url: string;
  title: string;
  active_app: string;
  screenshot_path: string | null;
  viewport: { width: number; height: number };
}

export class Observer {
  constructor(private runDir: string) {}

  async captureSnapshot(page: Page, label: string): Promise<Snapshot> {
    const screenshotPath = await this.captureScreenshot(page, label);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    // Skip getActiveApp() during recording — the AppleScript call
    // can steal focus and cause window flickering
    return {
      timestamp: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      active_app: "chrome",
      screenshot_path: screenshotPath,
      viewport,
    };
  }

  async captureScreenshot(page: Page, name: string): Promise<string> {
    const filepath = join(this.runDir, "screenshots", `${name}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    return filepath;
  }

  async getActiveApp(): Promise<string> {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    return stdout.trim();
  }

  async getCurrentUrl(page: Page): Promise<string> {
    return page.url();
  }
}
