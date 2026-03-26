import type { Action } from "../schema/action.js";
import type { Plan } from "../schema/plan.js";
import type { StepLog } from "../executor/executor.js";
import type { EventLogger } from "../recording/event-logger.js";

// --- Agent Configuration ---

export interface AgentOptions {
  task: string;
  maxIterations: number;
  maxTotalSteps: number;
  totalTimeoutMs: number;
  chunkSize: number;
  headless: boolean;
  traceDir: string;
  verbose: boolean;
  slowMo: number;
  model: string;
  startUrl?: string;
  cursor?: boolean;
  cursorSpeed?: number;
  eventLogger?: EventLogger;
  recordVideoDir?: string;
  computerUse?: boolean;
}

// --- Page Context ---

export interface PageElement {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface SemanticSnapshot {
  navigation: string[];
  forms: Array<{
    name: string;
    fields: Array<{ label: string; type: string; value: string; selector: string }>;
    buttons: string[];
  }>;
  headings: string[];
  buttons: Array<{ text: string; selector: string }>;
  links: Array<{ text: string; href: string; selector: string }>;
  canvasRegions: Array<{ x: number; y: number; width: number; height: number }>;
  textSummary: string;
}

export interface PageContext {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  elements: PageElement[];
  semantic: SemanticSnapshot;
  screenshotPath: string;
  screenshotBase64: string;
}

// --- LLM Communication ---

export interface LlmPlanResponse {
  thinking: string;
  status: "continue" | "task_complete" | "task_impossible";
  steps: Action[];
  completionMessage?: string;
  impossibleReason?: string;
}

// --- Execution ---

export interface ChunkResult {
  steps: StepLog[];
  result: "success" | "failure";
  failedAtStep?: number;
  errorSummary?: string;
  verification?: string;
}

// --- Conversation History ---

export interface AgentIteration {
  iteration: number;
  timestamp: string;
  pageContext: Omit<PageContext, "screenshotBase64">;
  llmResponse: {
    raw: string;
    parsed: LlmPlanResponse;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
  };
  generatedPlan: Plan | null;
  executionResult: ChunkResult | null;
}

// --- Final Agent Result ---

export interface AgentResult {
  taskDescription: string;
  result: "success" | "failure" | "impossible" | "timeout" | "max_iterations";
  totalIterations: number;
  totalStepsExecuted: number;
  totalDurationMs: number;
  iterations: AgentIteration[];
  traceDir: string;
  finalMessage?: string;
}
