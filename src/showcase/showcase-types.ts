import type { AgentResult } from "../agent/agent-types.js";

export interface ShowcaseOptions {
  projectPath: string;
  startCmd?: string;
  port?: number;
  url?: string;
  instructions?: string;
  maxScenarios: number;
  skipConfirm: boolean;
  cursor: boolean;
  cursorSpeed: number;
  record?: boolean;
  raw?: boolean;
  zoom?: number;
  fps?: number;
  headless: boolean;
  computerUse?: boolean;
  traceDir: string;
  verbose: boolean;
  slowMo: number;
  model: string;
}

export interface ProjectInfo {
  name: string;
  framework: string;
  startCommand: string;
  startUrl: string;
  routes: string[];
  components: string[];
  readme: string;
  keyFiles: { path: string; content: string }[];
}

export interface DemoScenario {
  title: string;
  description: string;
  startPath: string;
  order: number;
}

export interface ShowcaseResult {
  projectName: string;
  framework: string;
  scenarios: Array<{
    scenario: DemoScenario;
    agentResult: AgentResult;
  }>;
  totalDurationMs: number;
  traceDir: string;
}
