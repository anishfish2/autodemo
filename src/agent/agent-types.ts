import type { EventLogger } from "../recording/event-logger.js";

// --- Agent Configuration ---

export interface AgentOptions {
  task: string;
  maxIterations: number;
  totalTimeoutMs: number;
  traceDir: string;
  model: string;
  startUrl?: string;
  eventLogger?: EventLogger;
}

// --- Final Agent Result ---

export interface AgentResult {
  taskDescription: string;
  result: "success" | "failure" | "impossible" | "timeout" | "max_iterations";
  totalIterations: number;
  totalStepsExecuted: number;
  totalDurationMs: number;
  traceDir: string;
  finalMessage?: string;
}
