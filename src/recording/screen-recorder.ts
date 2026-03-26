import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ScreenRecorder {
  private process: ChildProcess | null = null;
  private outputPath: string = "";
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async start(
    outputPath: string,
    options?: { display?: number; fps?: number },
  ): Promise<void> {
    const display = options?.display ?? 0;
    const fps = options?.fps ?? 30;
    this.outputPath = outputPath;

    this.logger.info({ outputPath, fps, display }, "Starting screen recording");

    // Detect the screen capture device index
    // AVFoundation lists cameras first, then screens as "Capture screen N"
    const screenDeviceIndex = await this.findScreenDeviceIndex(display);

    // Use ffmpeg to capture screen via AVFoundation
    this.process = spawn(
      "ffmpeg",
      [
        "-y", // Overwrite output
        "-f",
        "avfoundation",
        "-framerate",
        String(fps),
        "-capture_cursor",
        "1", // Capture the cursor
        "-capture_mouse_clicks",
        "1", // Highlight clicks
        "-i",
        `${screenDeviceIndex}:none`, // Screen device index : no audio
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast", // Fast encoding during capture, re-encode in post
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18", // High quality
        outputPath,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Log ffmpeg stderr (progress info)
    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.startsWith("frame=")) {
        this.logger.debug({ ffmpeg: true }, line);
      }
    });

    this.process.on("error", (err) => {
      this.logger.error({ error: err.message }, "FFmpeg process error");
    });

    // Give ffmpeg a moment to initialize
    await sleep(1000);
    this.logger.info("Screen recording started");
  }

  async stop(): Promise<string> {
    if (!this.process) {
      throw new Error("No recording in progress");
    }

    this.logger.info("Stopping screen recording...");

    // Send 'q' to ffmpeg stdin for graceful stop
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful stop takes too long
        this.process?.kill("SIGKILL");
        resolve(this.outputPath);
      }, 10000);

      this.process!.on("close", () => {
        clearTimeout(timeout);
        this.logger.info(
          { outputPath: this.outputPath },
          "Screen recording saved",
        );
        this.process = null;
        resolve(this.outputPath);
      });

      // Send 'q' to stop recording gracefully
      this.process!.stdin?.write("q");
      this.process!.stdin?.end();
    });
  }

  isRecording(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private async findScreenDeviceIndex(display: number): Promise<number> {
    try {
      const output = execSync(
        'ffmpeg -f avfoundation -list_devices true -i "" 2>&1',
        { encoding: "utf-8" },
      ).toString();
      // Find "Capture screen N" and get its device index
      const regex = /\[(\d+)\] Capture screen (\d+)/g;
      let match;
      while ((match = regex.exec(output)) !== null) {
        if (parseInt(match[2], 10) === display) {
          return parseInt(match[1], 10);
        }
      }
    } catch (err) {
      // execSync throws on non-zero exit (ffmpeg -list_devices always errors)
      const output = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      const regex = /\[(\d+)\] Capture screen (\d+)/g;
      let match;
      while ((match = regex.exec(output)) !== null) {
        if (parseInt(match[2], 10) === display) {
          return parseInt(match[1], 10);
        }
      }
    }
    // Fallback: assume screen 0 is at device index 4 (typical for single-camera Macs)
    this.logger.warn(
      { display },
      "Could not detect screen device index — falling back to 4",
    );
    return 4;
  }
}
