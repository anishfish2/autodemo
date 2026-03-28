import type {
  ShowcaseOptions,
  ShowcaseResult,
  ProjectInfo,
  DemoScenario,
} from "./showcase-types.js";
import { analyzeProject } from "./project-analyzer.js";
import { planShowcase } from "./showcase-planner.js";
import { AppLauncher } from "./app-launcher.js";
import { runAgent } from "../agent/agent-runner.js";
import { createLogger } from "../trace/logger.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { nanoid } from "nanoid";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal ProjectInfo for a live URL with no local source code.
 * The planner will work with just the URL and any user instructions.
 */
function projectInfoForUrl(url: string): ProjectInfo {
  const hostname = new URL(url).hostname;
  return {
    name: hostname,
    framework: "unknown",
    packageManager: "npm",
    startCommand: "",
    port: 0,
    startUrl: url,
    routes: [],
    apiEndpoints: [],
    components: [],
    uiFeatures: {
      hasForms: false,
      hasAuth: false,
      hasNavigation: false,
      hasDataTables: false,
      hasCharts: false,
      hasModals: false,
      hasMedia: false,
      details: [],
    },
    fileTree: "",
    readme: "",
    keyFiles: [],
    notableDependencies: [],
  };
}

export async function runShowcase(
  options: ShowcaseOptions,
): Promise<ShowcaseResult> {
  const showcaseId = `showcase_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${nanoid(6)}`;
  const showcaseDir = join(options.traceDir, showcaseId);
  mkdirSync(showcaseDir, { recursive: true });

  const logger = createLogger(showcaseDir, options.verbose);
  const startMs = Date.now();

  const isUrlOnly = !options.projectPath;

  // === 1. ANALYZE ===
  let projectInfo: ProjectInfo;

  if (isUrlOnly) {
    projectInfo = projectInfoForUrl(options.url!);
    console.log(`\nTarget: ${projectInfo.startUrl} (live URL, no source analysis)\n`);
  } else {
    logger.info({ path: options.projectPath }, "Analyzing project...");
    projectInfo = await analyzeProject(options.projectPath);

    // Apply overrides
    if (options.startCmd) {
      projectInfo.startCommand = options.startCmd;
    }
    if (options.port) {
      projectInfo.port = options.port;
      projectInfo.startUrl = `http://localhost:${options.port}`;
    }
    if (options.url) {
      projectInfo.startUrl = options.url;
    }

    logger.info(
      {
        name: projectInfo.name,
        framework: projectInfo.framework,
        routes: projectInfo.routes.length,
        components: projectInfo.components.length,
        startCommand: projectInfo.startCommand,
        startUrl: projectInfo.startUrl,
      },
      "Project analyzed",
    );

    console.log(`\nProject: ${projectInfo.name} (${projectInfo.framework}, ${projectInfo.packageManager})`);
    console.log(`Routes: ${projectInfo.routes.map((r) => r.path).join(", ") || "(none detected)"}`);
    if (projectInfo.apiEndpoints.length > 0) {
      console.log(`API: ${projectInfo.apiEndpoints.join(", ")}`);
    }
    if (projectInfo.notableDependencies.length > 0) {
      console.log(`Deps: ${projectInfo.notableDependencies.join(", ")}`);
    }
    console.log(`Components: ${projectInfo.components.length} found`);
    console.log(`Start: ${projectInfo.startCommand} → ${projectInfo.startUrl}\n`);
  }

  // === 2. PLAN ===
  const scenarios = await planShowcase(
    projectInfo,
    options.model,
    logger,
    options.maxScenarios,
    options.instructions,
  );

  console.log(`Demo plan (${scenarios.length} scenarios):`);
  for (const s of scenarios) {
    console.log(`  ${s.order}. ${s.title} (${s.startPath})`);
    console.log(`     ${s.description.slice(0, 100)}${s.description.length > 100 ? "..." : ""}`);
  }
  console.log();

  // === 3. LAUNCH APP (only for local projects without a URL override) ===
  const appLauncher = new AppLauncher(logger);
  const shouldLaunch = !isUrlOnly && !options.url;

  if (shouldLaunch) {
    try {
      await appLauncher.start(
        options.projectPath,
        projectInfo.startCommand,
        projectInfo.startUrl,
      );
      const actualUrl = appLauncher.getActualUrl();
      if (actualUrl && actualUrl !== projectInfo.startUrl) {
        logger.info(
          { expected: projectInfo.startUrl, actual: actualUrl },
          "Dev server started on different port",
        );
        projectInfo.startUrl = actualUrl;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to start dev server: ${msg}`);
      console.error(`Try starting it manually and use --url to point to it.`);
      throw err;
    }
  }

  // === 4. EXECUTE DEMOS ===
  const results: ShowcaseResult["scenarios"] = [];

  try {
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      console.log(
        `\n--- Scenario ${i + 1}/${scenarios.length}: ${scenario.title} ---`,
      );

      let task = scenario.description;
      if (scenario.interactionHints?.length) {
        task += `\n\nKey elements to interact with: ${scenario.interactionHints.join(", ")}`;
      }
      if (scenario.successCriteria) {
        task += `\n\nSuccess criteria: ${scenario.successCriteria}`;
      }
      if (options.instructions) {
        task += `\n\nAdditional context: ${options.instructions}`;
      }

      let agentResult;
      try {
        agentResult = await runAgent({
          task,
          startUrl: projectInfo.startUrl + scenario.startPath,
          maxIterations: 50,
          totalTimeoutMs: 600000,
          traceDir: showcaseDir,
          model: options.model,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ error: errorMsg, scenario: scenario.title }, "Scenario crashed");
        console.error(`\n✗ ${scenario.title}: CRASHED — ${errorMsg}`);
        break;
      }

      results.push({ scenario, agentResult });

      const icon = agentResult.result === "success" ? "✓" : "✗";
      console.log(
        `${icon} ${scenario.title}: ${agentResult.result} (${agentResult.totalIterations} iters, ${agentResult.totalStepsExecuted} steps)`,
      );

      if (agentResult.result === "failure") {
        logger.warn("Scenario failed — stopping showcase to keep video clean");
        break;
      }

      if (i < scenarios.length - 1) {
        await sleep(2000);
      }
    }
  } finally {
    // === 5. CLEANUP ===
    if (shouldLaunch) {
      await appLauncher.stop();
    }
  }

  const showcaseResult: ShowcaseResult = {
    projectName: projectInfo.name,
    framework: projectInfo.framework,
    scenarios: results,
    totalDurationMs: Date.now() - startMs,
    traceDir: showcaseDir,
  };

  writeFileSync(
    join(showcaseDir, "showcase-summary.json"),
    JSON.stringify(showcaseResult, null, 2),
  );

  return showcaseResult;
}
