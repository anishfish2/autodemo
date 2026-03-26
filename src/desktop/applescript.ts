import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function runAppleScript(script: string, timeoutMs = 10000): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: timeoutMs,
  });
  return stdout.trim();
}

export class AppleScriptBridge {
  async openApp(appName: string): Promise<void> {
    const escaped = escapeAppleScript(appName);
    await runAppleScript(`tell application "${escaped}" to activate`);
    // Give the app a moment to launch
    await new Promise((r) => setTimeout(r, 1000));
  }

  async focusApp(appName: string): Promise<void> {
    const escaped = escapeAppleScript(appName);
    await runAppleScript(
      `tell application "${escaped}" to activate`,
    );
  }

  async getActiveApp(): Promise<string> {
    return runAppleScript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
  }

  async pressSystemKeys(keys: string): Promise<void> {
    // This handles basic key combos like "command+shift+a"
    // For more complex cases, use Playwright's keyboard
    const escaped = escapeAppleScript(keys);
    await runAppleScript(
      `tell application "System Events" to keystroke "${escaped}"`,
    );
  }
}
