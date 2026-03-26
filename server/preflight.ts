import { execSync } from "node:child_process";

export interface PreflightCheck {
  name: string;
  status: "ok" | "missing" | "warning";
  message: string;
  fix?: string;
}

export function runPreflight(): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  // 1. FFmpeg
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    checks.push({ name: "FFmpeg", status: "ok", message: "Installed" });
  } catch {
    checks.push({
      name: "FFmpeg",
      status: "missing",
      message: "FFmpeg is required for screen recording and video processing",
      fix: "brew install ffmpeg",
    });
  }

  // 2. macOS Accessibility
  try {
    // Try a no-op CoreGraphics call to see if we have permission
    execSync(
      'osascript -l JavaScript -e \'ObjC.import("CoreGraphics"); $.CGMainDisplayID()\'',
      { stdio: "ignore", timeout: 5000 },
    );
    checks.push({ name: "Screen access", status: "ok", message: "Granted" });
  } catch {
    checks.push({
      name: "Screen access",
      status: "warning",
      message: "May need Accessibility permission for mouse control",
      fix: "System Settings → Privacy & Security → Accessibility → enable your terminal app",
    });
  }

  // 3. Google Chrome
  try {
    execSync("ls /Applications/Google\\ Chrome.app", { stdio: "ignore" });
    checks.push({ name: "Google Chrome", status: "ok", message: "Installed" });
  } catch {
    checks.push({
      name: "Google Chrome",
      status: "warning",
      message: "Chrome is used for opening URLs during recording",
      fix: "Download from https://google.com/chrome",
    });
  }

  // 4. screencapture (should always be there on macOS)
  try {
    execSync("which screencapture", { stdio: "ignore" });
    checks.push({ name: "Screen capture", status: "ok", message: "Available" });
  } catch {
    checks.push({
      name: "Screen capture",
      status: "missing",
      message: "screencapture command not found",
    });
  }

  return checks;
}

export function printPreflight(checks: PreflightCheck[]): void {
  const hasIssues = checks.some((c) => c.status !== "ok");

  if (!hasIssues) {
    console.log("  All checks passed ✓\n");
    return;
  }

  console.log("");
  for (const c of checks) {
    if (c.status === "ok") {
      console.log(`  ✓ ${c.name}: ${c.message}`);
    } else if (c.status === "missing") {
      console.log(`  ✗ ${c.name}: ${c.message}`);
      if (c.fix) console.log(`    Fix: ${c.fix}`);
    } else {
      console.log(`  ⚠ ${c.name}: ${c.message}`);
      if (c.fix) console.log(`    Fix: ${c.fix}`);
    }
  }
  console.log("");
}
