import type { AgentOptions, AgentResult } from "./agent-types.js";
import { runNativeComputerUseAgent } from "./computer-use-native.js";

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  return runNativeComputerUseAgent(options);
}
