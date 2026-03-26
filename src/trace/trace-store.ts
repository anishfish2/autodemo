import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Plan } from "../schema/plan.js";
import type { StepLog, RunSummary } from "../executor/executor.js";

function makeRunId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14); // 20260320143052
  return `run_${ts}_${nanoid(6)}`;
}

export class TraceStore {
  readonly runId: string;
  readonly runDir: string;
  private stepsDir: string;
  private screenshotsDir: string;

  constructor(baseDir: string) {
    this.runId = makeRunId();
    this.runDir = join(baseDir, this.runId);
    this.stepsDir = join(this.runDir, "steps");
    this.screenshotsDir = join(this.runDir, "screenshots");
  }

  async init(plan: Plan): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(this.stepsDir, { recursive: true });
    mkdirSync(this.screenshotsDir, { recursive: true });

    // Write normalized plan
    writeFileSync(
      join(this.runDir, "normalized-plan.json"),
      JSON.stringify(plan, null, 2),
    );
  }

  async writeStepLog(log: StepLog): Promise<void> {
    const filename = `${String(log.step_index).padStart(2, "0")}-${log.action}.json`;
    writeFileSync(join(this.stepsDir, filename), JSON.stringify(log, null, 2));
  }

  async writeScreenshot(data: Buffer, name: string): Promise<string> {
    const filename = `${name}.png`;
    const filepath = join(this.screenshotsDir, filename);
    writeFileSync(filepath, data);
    return filepath;
  }

  getScreenshotPath(name: string): string {
    return join(this.screenshotsDir, `${name}.png`);
  }

  async finalize(summary: RunSummary): Promise<void> {
    writeFileSync(
      join(this.runDir, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
  }
}
