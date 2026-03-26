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
  .description("macOS computer-use agent — execute structured automation plans")
  .version("0.1.0");

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
  .command("run")
  .description("Execute an automation plan")
  .argument("<plan-file>", "Path to plan file (JSON or YAML)")
  .option("--headless", "Run browser in headless mode", false)
  .option("--trace-dir <dir>", "Output directory for traces", "./traces")
  .option("--verbose", "Enable verbose logging", false)
  .option("--slow-mo <ms>", "Slow down actions by N ms", "0")
  .option("--step <index>", "Execute only a single step (for debugging)")
  .option("--dry-run", "Validate and print normalized plan without executing", false)
  .option("--cursor", "Animate real system cursor for Screen Studio recording", false)
  .option("--cursor-speed <ms>", "Cursor animation duration in ms", "600")
  .action(async (planFile: string, options) => {
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

    if (options.dryRun) {
      console.log("\n✓ Plan is valid (dry run).\n");
      console.log(JSON.stringify(result.plan, null, 2));
      process.exit(0);
    }

    // Executor will be wired in Phase 2
    const { executePlan } = await import("../src/executor/executor.js");
    const summary = await executePlan(result.plan!, {
      headless: options.headless,
      traceDir: options.traceDir,
      verbose: options.verbose,
      slowMo: parseInt(options.slowMo, 10),
      singleStep:
        options.step !== undefined ? parseInt(options.step, 10) : undefined,
      cursor: options.cursor,
      cursorSpeed: parseInt(options.cursorSpeed, 10),
    });

    console.log(
      `\n${summary.result === "success" ? "✓" : "✗"} Run ${summary.run_id}: ${summary.result} (${summary.passed_steps}/${summary.total_steps} steps passed) in ${summary.duration_ms}ms`,
    );
    console.log(`  Trace: ${summary.trace_dir}`);
    process.exit(summary.result === "success" ? 0 : 1);
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
      .filter((d) => d.isDirectory() && (d.name.startsWith("run_") || d.name.startsWith("agent_")))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, parseInt(options.limit, 10));

    if (entries.length === 0) {
      console.log("No trace runs found.");
      return;
    }

    console.log(`Recent runs (${entries.length}):\n`);
    for (const entry of entries) {
      const summaryPath = join(traceDir, entry.name, "summary.json");
      // Check for agent summary first, then plan summary
      const agentSummaryPath = join(traceDir, entry.name, "agent-summary.json");
      if (existsSync(agentSummaryPath)) {
        const summary = JSON.parse(readFileSync(agentSummaryPath, "utf-8"));
        const icon = summary.result === "success" ? "✓" : "✗";
        console.log(
          `  ${icon} ${entry.name}  [agent] "${summary.taskDescription}"  ${summary.totalIterations} iters, ${summary.totalStepsExecuted} steps  ${summary.totalDurationMs}ms`,
        );
      } else if (existsSync(summaryPath)) {
        const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
        const icon = summary.result === "success" ? "✓" : "✗";
        console.log(
          `  ${icon} ${entry.name}  ${summary.plan_name}  ${summary.passed_steps}/${summary.total_steps} passed  ${summary.duration_ms}ms`,
        );
      } else {
        console.log(`  ? ${entry.name}  (no summary)`);
      }
    }
  });

program
  .command("agent")
  .description("Run an autonomous agent that plans and executes a task from natural language")
  .argument("<task>", "Natural language task description")
  .option("--max-iterations <n>", "Maximum planning iterations", "15")
  .option("--max-steps <n>", "Maximum total steps across all iterations", "50")
  .option("--timeout <ms>", "Total agent timeout in ms", "300000")
  .option("--chunk-size <n>", "Max steps per chunk", "5")
  .option("--headless", "Run browser in headless mode", false)
  .option("--trace-dir <dir>", "Output directory for traces", "./traces")
  .option("--verbose", "Enable verbose logging", false)
  .option("--slow-mo <ms>", "Slow down actions by N ms", "0")
  .option("--model <model>", "Claude model to use", "claude-sonnet-4-20250514")
  .option("--start-url <url>", "Starting URL for the browser")
  .option("--cursor", "Animate real system cursor for Screen Studio recording", false)
  .option("--cursor-speed <ms>", "Cursor animation duration in ms", "600")
  .option("--computer-use", "Use Claude computer use tool (vision-based, works with any UI)", false)
  .action(async (task: string, options) => {
    const { runAgent } = await import("../src/agent/agent-runner.js");

    const result = await runAgent({
      task,
      maxIterations: parseInt(options.maxIterations, 10),
      maxTotalSteps: parseInt(options.maxSteps, 10),
      totalTimeoutMs: parseInt(options.timeout, 10),
      chunkSize: parseInt(options.chunkSize, 10),
      headless: options.headless,
      traceDir: options.traceDir,
      verbose: options.verbose,
      slowMo: parseInt(options.slowMo, 10),
      model: options.model,
      startUrl: options.startUrl,
      cursor: options.cursor,
      cursorSpeed: parseInt(options.cursorSpeed, 10),
      computerUse: options.computerUse,
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
  .description("Analyze a project's code and auto-demo its features")
  .argument("<project-path>", "Path to the web app project")
  .option("--start-cmd <cmd>", "Override the dev server start command")
  .option("--port <n>", "Override the dev server port")
  .option("--url <url>", "Use a running server URL (skip auto-launch)")
  .option("--scenarios <n>", "Max number of features to demo", "5")
  .option("-i, --instructions <text>", "Additional instructions (login credentials, context, preferences)")
  .option("--yes", "Skip confirmation", false)
  .option("--cursor", "Animate real system cursor (default: true for showcase)", true)
  .option("--cursor-speed <ms>", "Cursor animation duration in ms", "600")
  .option("--record", "Record screen and produce video (default: true)", true)
  .option("--no-record", "Disable screen recording")
  .option("--raw", "Skip post-processing, keep raw screen capture only", false)
  .option("--zoom <level>", "Zoom magnification for post-processing (1 = no zoom)", "1")
  .option("--fps <n>", "Recording framerate", "30")
  .option("--headless", "Run browser in headless mode (default: true for showcase)", true)
  .option("--no-headless", "Run with visible browser")
  .option("--computer-use", "Use Claude computer use tool (default: true)", true)
  .option("--no-computer-use", "Use DOM-based agent instead")
  .option("--trace-dir <dir>", "Output directory for traces", "./traces")
  .option("--verbose", "Enable verbose logging", false)
  .option("--slow-mo <ms>", "Slow down actions by N ms", "0")
  .option("--model <model>", "Claude model to use", "claude-sonnet-4-20250514")
  .action(async (projectPath: string, options) => {
    const { resolve } = await import("node:path");
    const { runShowcase } = await import("../src/showcase/showcase-runner.js");

    const result = await runShowcase({
      projectPath: resolve(projectPath),
      startCmd: options.startCmd,
      port: options.port ? parseInt(options.port, 10) : undefined,
      url: options.url,
      instructions: options.instructions,
      maxScenarios: parseInt(options.scenarios, 10),
      skipConfirm: options.yes,
      cursor: options.cursor,
      cursorSpeed: parseInt(options.cursorSpeed, 10),
      record: options.record,
      raw: options.raw,
      zoom: parseFloat(options.zoom),
      fps: parseInt(options.fps, 10),
      headless: options.headless,
      computerUse: options.computerUse,
      traceDir: options.traceDir,
      verbose: options.verbose,
      slowMo: parseInt(options.slowMo, 10),
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
