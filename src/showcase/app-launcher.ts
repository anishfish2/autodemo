import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppLauncher {
  private process: ChildProcess | null = null;
  private logger: Logger;
  private actualUrl: string | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async start(
    projectPath: string,
    command: string,
    url: string,
    timeoutMs = 60000,
  ): Promise<void> {
    this.logger.info(
      { command, cwd: projectPath },
      "Starting dev server...",
    );

    // Split command into parts
    const [cmd, ...args] = command.split(" ");

    this.process = spawn(cmd, args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: true,
    });

    // Watch server output for the actual URL (port may differ)
    let detectedUrl: string | null = null;
    const urlDetector = (data: Buffer) => {
      const line = data.toString();
      // Match common dev server URL patterns:
      // Vite: "Local:   http://localhost:3002/"
      // Next.js: "- Local: http://localhost:3000"
      // CRA: "Local:            http://localhost:3000"
      const match = line.match(/https?:\/\/localhost:\d+/);
      if (match && !detectedUrl) {
        detectedUrl = match[0];
        this.logger.info({ detectedUrl }, "Detected dev server URL from output");
      }
    };

    this.process.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.debug({ server: true }, line);
      urlDetector(data);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.debug({ server: true, stderr: true }, line);
      urlDetector(data);
    });

    this.process.on("error", (err) => {
      this.logger.error({ error: err.message }, "Dev server process error");
    });

    // Wait for server to be ready — use detected URL if port changed
    // Pass a getter so waitForReady sees the latest detected URL on each poll
    const actualUrl = await this.waitForReady(url, () => detectedUrl, timeoutMs);
    this.actualUrl = actualUrl;
    this.logger.info({ url: actualUrl }, "Dev server is ready");
  }

  getActualUrl(): string | null {
    return this.actualUrl;
  }

  private async waitForReady(
    url: string,
    getDetectedUrl: () => string | null,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 1000;

    while (Date.now() < deadline) {
      const detectedUrl = getDetectedUrl();
      // Try the detected URL first (from server output), then the expected URL
      const urlsToTry = detectedUrl
        ? [detectedUrl, url]
        : [url];

      for (const tryUrl of urlsToTry) {
        try {
          const response = await fetch(tryUrl, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok || response.status < 500) {
            return tryUrl;
          }
        } catch {
          // Not ready yet
        }
      }
      await sleep(pollInterval);
    }

    const detectedUrl = getDetectedUrl();
    throw new Error(
      `Dev server did not become ready at ${url}${detectedUrl ? ` or ${detectedUrl}` : ""} within ${timeoutMs}ms`,
    );
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.logger.info("Stopping dev server...");

    try {
      // Kill the process group (negative PID kills the group)
      if (this.process.pid) {
        process.kill(-this.process.pid, "SIGTERM");
      }
    } catch {
      // Process may already be dead
    }

    // Give it a moment to clean up
    await sleep(500);

    try {
      if (this.process.pid) {
        process.kill(-this.process.pid, "SIGKILL");
      }
    } catch {
      // Already dead
    }

    this.process = null;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
