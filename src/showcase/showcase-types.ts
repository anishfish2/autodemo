import type { AgentResult } from "../agent/agent-types.js";

// --- Project Analysis ---

export interface RouteInfo {
  path: string;
  filePath: string;
  hasForm: boolean;
  hasDataFetching: boolean;
  hasInteractiveElements: boolean;
  title?: string;
}

export interface UIFeatures {
  hasForms: boolean;
  hasAuth: boolean;
  hasNavigation: boolean;
  hasDataTables: boolean;
  hasCharts: boolean;
  hasModals: boolean;
  hasMedia: boolean;
  details: { feature: string; routes: string[]; evidence: string }[];
}

export interface ProjectInfo {
  name: string;
  framework: string;
  packageManager: "npm" | "yarn" | "pnpm" | "bun";
  startCommand: string;
  port: number;
  startUrl: string;
  routes: RouteInfo[];
  apiEndpoints: string[];
  components: string[];
  uiFeatures: UIFeatures;
  fileTree: string;
  readme: string;
  keyFiles: { path: string; content: string }[];
  notableDependencies: string[];
}

// --- Demo Planning ---

export interface DemoScenario {
  title: string;
  description: string;
  startPath: string;
  order: number;
  interactionHints?: string[];
  successCriteria?: string;
}

// --- Showcase Orchestration ---

export interface ShowcaseOptions {
  projectPath: string;
  startCmd?: string;
  port?: number;
  url?: string;
  instructions?: string;
  maxScenarios: number;
  skipConfirm: boolean;
  traceDir: string;
  verbose: boolean;
  model: string;
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
