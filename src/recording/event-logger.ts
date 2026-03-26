import { writeFileSync } from "node:fs";
import type { RecordingEvent, DirectorEventData } from "./recording-types.js";

export class EventLogger {
  private events: RecordingEvent[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  reset(): void {
    this.startTime = Date.now();
    this.events = [];
  }

  logCursorPosition(x: number, y: number): void {
    this.events.push({
      type: "cursor",
      timestamp: Date.now() - this.startTime,
      x,
      y,
    });
  }

  logClick(x: number, y: number, button = "left"): void {
    this.events.push({
      type: "click",
      timestamp: Date.now() - this.startTime,
      x,
      y,
      button,
    });
  }

  logScenarioStart(title: string): void {
    this.events.push({
      type: "scenario_start",
      timestamp: Date.now() - this.startTime,
      title,
    });
  }

  logScenarioEnd(title: string): void {
    this.events.push({
      type: "scenario_end",
      timestamp: Date.now() - this.startTime,
      title,
    });
  }

  logDirectorEvent(data: DirectorEventData): void {
    this.events.push({
      ...data,
      timestamp: Date.now() - this.startTime,
    });
  }

  getEvents(): RecordingEvent[] {
    return this.events;
  }

  save(outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(this.events, null, 2));
  }
}
