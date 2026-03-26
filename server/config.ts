import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".demoo");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface DemooConfig {
  anthropicApiKey?: string;
  defaultModel: string;
  maxIterations: number;
  timeout: number;
}

const DEFAULTS: DemooConfig = {
  defaultModel: "claude-sonnet-4-20250514",
  maxIterations: 50,
  timeout: 600000,
};

export function loadConfig(): DemooConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Partial<DemooConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}

export function getApiKey(): string | undefined {
  const config = loadConfig();
  return config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
}
