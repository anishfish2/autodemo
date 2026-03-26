import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { AgentIteration, AgentResult } from "./agent-types.js";

function makeAgentRunId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `agent_${ts}_${nanoid(6)}`;
}

export class AgentTraceStore {
  readonly runId: string;
  readonly runDir: string;
  private iterationsDir: string;
  readonly screenshotsDir: string;

  constructor(baseDir: string) {
    this.runId = makeAgentRunId();
    this.runDir = join(baseDir, this.runId);
    this.iterationsDir = join(this.runDir, "iterations");
    this.screenshotsDir = join(this.runDir, "screenshots");
  }

  async init(task: string): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(this.iterationsDir, { recursive: true });
    mkdirSync(this.screenshotsDir, { recursive: true });

    writeFileSync(
      join(this.runDir, "task.json"),
      JSON.stringify(
        { task, startedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  }

  getScreenshotPath(name: string): string {
    return join(this.screenshotsDir, `${name}.png`);
  }

  getIterationDir(iteration: number): string {
    return join(
      this.iterationsDir,
      `iteration-${String(iteration).padStart(2, "0")}`,
    );
  }

  async writeIteration(iteration: AgentIteration): Promise<void> {
    const iterDir = this.getIterationDir(iteration.iteration);
    mkdirSync(iterDir, { recursive: true });

    writeFileSync(
      join(iterDir, "iteration.json"),
      JSON.stringify(iteration, null, 2),
    );
  }

  async finalize(result: AgentResult): Promise<void> {
    writeFileSync(
      join(this.runDir, "agent-summary.json"),
      JSON.stringify(result, null, 2),
    );
  }
}
