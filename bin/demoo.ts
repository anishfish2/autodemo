#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validatePlan } from "../src/validator/plan-validator.js";

function readPlanFile(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return parseYaml(content);
  }
  return JSON.parse(content);
}

const program = new Command()
  .name("demoo")
  .description("macOS computer-use agent — automated demo video generation")
  .version("0.1.0")
  .option("-p, --port <port>", "Port for the web UI", "3456")
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    // No subcommand = launch web UI
    const { startServer } = await import("../server/index.js");
    startServer(port);
    // Open browser
    const { exec } = await import("node:child_process");
    setTimeout(() => exec(`open http://localhost:${port}`), 1000);
  });

program
  .command("validate")
  .description("Validate a plan file without executing")
  .argument("<plan-file>", "Path to plan file (JSON or YAML)")
  .action((planFile: string) => {
    const raw = readPlanFile(planFile);
    const result = validatePlan(raw);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.warn(`⚠ ${w}`);
      }
    }

    if (!result.valid) {
      console.error("\n✗ Plan validation failed:\n");
      for (const err of result.errors) {
        console.error(`  [${err.path}] ${err.message}`);
      }
      process.exit(1);
    }

    console.log("\n✓ Plan is valid.\n");
    console.log("Normalized plan:\n");
    console.log(JSON.stringify(result.plan, null, 2));
  });

program
  .command("list-traces")
  .description("List recent trace runs")
  .option("--trace-dir <dir>", "Traces directory", "./traces")
  .option("--limit <n>", "Number of runs to show", "10")
  .action((options) => {
    const traceDir = options.traceDir;
    if (!existsSync(traceDir)) {
      console.log("No traces directory found.");
      return;
    }

    const entries = readdirSync(traceDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("agent_"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, parseInt(options.limit, 10));

    if (entries.length === 0) {
      console.log("No trace runs found.");
      return;
    }

    console.log(`Recent runs (${entries.length}):\n`);
    for (const entry of entries) {
      const agentSummaryPath = join(traceDir, entry.name, "agent-summary.json");
      if (existsSync(agentSummaryPath)) {
        const summary = JSON.parse(readFileSync(agentSummaryPath, "utf-8"));
        const icon = summary.result === "success" ? "✓" : "✗";
        console.log(
          `  ${icon} ${entry.name}  "${summary.taskDescription}"  ${summary.totalIterations} iters, ${summary.totalStepsExecuted} steps  ${summary.totalDurationMs}ms`,
        );
      } else {
        console.log(`  ? ${entry.name}  (no summary)`);
      }
    }
  });

program
  .command("agent")
  .description("Run an autonomous agent that executes a task using Claude computer use")
  .argument("<task>", "Natural language task description")
  .option("--max-iterations <n>", "Maximum agent iterations", "15")
  .option("--timeout <ms>", "Total agent timeout in ms", "300000")
  .option("--trace-dir <dir>", "Output directory for traces", "./traces")
  .option("--model <model>", "Claude model to use", "claude-sonnet-4-20250514")
  .option("--start-url <url>", "Starting URL to open")
  .action(async (task: string, options) => {
    const { runAgent } = await import("../src/agent/agent-runner.js");

    const result = await runAgent({
      task,
      maxIterations: parseInt(options.maxIterations, 10),
      totalTimeoutMs: parseInt(options.timeout, 10),
      traceDir: options.traceDir,
      model: options.model,
      startUrl: options.startUrl,
    });

    const icon = result.result === "success" ? "✓" : "✗";
    console.log(
      `\n${icon} Agent ${result.result}: ${result.totalIterations} iterations, ${result.totalStepsExecuted} steps, ${result.totalDurationMs}ms`,
    );
    if (result.finalMessage) {
      console.log(`  ${result.finalMessage}`);
    }
    console.log(`  Trace: ${result.traceDir}`);
    process.exit(result.result === "success" ? 0 : 1);
  });

program
  .command("showcase")
  .description("Auto-demo a local project or live website")
  .argument("<target>", "Local project path or URL (e.g. ./my-app or https://example.com)")
  .option("--start-cmd <cmd>", "Override the dev server start command")
  .option("--port <n>", "Override the dev server port")
  .option("--scenarios <n>", "Max number of features to demo", "5")
  .option("-i, --instructions <text>", "Additional instructions (login credentials, context, preferences)")
  .option("--yes", "Skip confirmation", false)
  .option("--trace-dir <dir>", "Output directory for traces", "./traces")
  .option("--verbose", "Enable verbose logging", false)
  .option("--model <model>", "Claude model to use", "claude-sonnet-4-20250514")
  .action(async (target: string, options) => {
    const { resolve } = await import("node:path");
    const { runShowcase } = await import("../src/showcase/showcase-runner.js");

    const isUrl = /^https?:\/\//.test(target);

    const result = await runShowcase({
      projectPath: isUrl ? "" : resolve(target),
      startCmd: options.startCmd,
      port: options.port ? parseInt(options.port, 10) : undefined,
      url: isUrl ? target : undefined,
      instructions: options.instructions,
      maxScenarios: parseInt(options.scenarios, 10),
      skipConfirm: options.yes,
      traceDir: options.traceDir,
      verbose: options.verbose,
      model: options.model,
    });

    const succeeded = result.scenarios.filter(
      (s) => s.agentResult.result === "success",
    ).length;
    const total = result.scenarios.length;

    console.log(
      `\n${succeeded === total ? "✓" : "✗"} Showcase complete: ${succeeded}/${total} scenarios succeeded in ${result.totalDurationMs}ms`,
    );
    console.log(`  Trace: ${result.traceDir}`);
    process.exit(succeeded === total ? 0 : 1);
  });

program.parse();
