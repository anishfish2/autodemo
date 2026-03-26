import { writeFileSync } from "node:fs";

export interface ActionLogEntry {
  t: number; // ms since recording start
  type:
    | "recording_start"
    | "llm_start"
    | "llm_end"
    | "action"
    | "action_done"
    | "screenshot";
  iteration?: number;
  action?: string;
  coords?: [number, number];
  thinking?: string;
}

export class ActionLog {
  private entries: ActionLogEntry[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.entries.push({ t: 0, type: "recording_start" });
  }

  log(entry: Omit<ActionLogEntry, "t">): void {
    this.entries.push({ ...entry, t: Date.now() - this.startTime });
  }

  getEntries(): ActionLogEntry[] {
    return this.entries;
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.entries, null, 2));
  }
}
