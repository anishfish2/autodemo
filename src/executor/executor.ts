import type { Page, BrowserContext } from "playwright";
import type { Logger } from "pino";
import type { Plan } from "../schema/plan.js";
import type { Action } from "../schema/action.js";
import type { TargetResolver } from "../target/target-resolver.js";
import { TargetResolver as TargetResolverImpl } from "../target/target-resolver.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { getActionHandler } from "../actions/index.js";
import { withTimeout, sleep } from "./retry.js";
import { createLogger } from "../trace/logger.js";
import { TraceStore } from "../trace/trace-store.js";
import { Observer } from "../observer/observer.js";
import { AssertionEngine } from "../assertion/assertion-engine.js";
import type { Snapshot } from "../observer/observer.js";
import type { AssertionResult } from "../assertion/assertion-engine.js";
import { CursorAnimator } from "../util/cursor-animator.js";

export interface ExecutionContext {
  page: Page;
  browserContext: BrowserContext;
  observer: Observer;
  targetResolver: TargetResolver;
  traceStore: TraceStore;
  logger: Logger;
  variables: Map<string, string>;
  stepIndex: number;
  aborted: boolean;
  cursorAnimator?: CursorAnimator;
}

export interface ExecutorOptions {
  headless: boolean;
  traceDir: string;
  verbose: boolean;
  slowMo: number;
  singleStep?: number;
  cursor?: boolean;
  cursorSpeed?: number;
}

export interface StepLog {
  step_index: number;
  step_id: string;
  action: string;
  description?: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  attempt: number;
  max_attempts: number;
  result: "success" | "failure" | "skipped";
  pre_state: Snapshot | null;
  post_state: Snapshot | null;
  assertions: AssertionResult[];
  error?: { code: string; message: string };
}

export interface RunSummary {
  run_id: string;
  trace_dir: string;
  plan_name: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  result: "success" | "failure" | "aborted";
  steps: StepLog[];
}

export async function executeStep(
  step: Action,
  ctx: ExecutionContext,
  assertionEngine: AssertionEngine,
): Promise<StepLog> {
  const stepId = step.id ?? `step_${ctx.stepIndex}_${step.action}`;
  const maxAttempts = step.retry.max_attempts;
  let lastError: { code: string; message: string } | undefined;
  let lastAssertions: AssertionResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    ctx.logger.info(
      { stepId, action: step.action, attempt, maxAttempts },
      `[step ${ctx.stepIndex}] ${step.action}${step.description ? ` — ${step.description}` : ""}`,
    );

    // Pre-state capture (skip during cursor/recording mode to avoid flicker)
    let preState: Snapshot | null = null;
    if (!ctx.cursorAnimator && (step.screenshot === "before" || step.screenshot === "both")) {
      preState = await ctx.observer
        .captureSnapshot(
          ctx.page,
          `${String(ctx.stepIndex).padStart(2, "0")}-${step.action}-before`,
        )
        .catch(() => null);
    }

    // Execute the action
    const handler = getActionHandler(step.action);
    let result;
    try {
      result = await withTimeout(
        handler.execute(step, ctx),
        step.timeout_ms,
        `${step.action} (step ${ctx.stepIndex})`,
      );
    } catch (err) {
      const errorObj = {
        code: "TIMEOUT",
        message: err instanceof Error ? err.message : String(err),
      };
      if (attempt < maxAttempts) {
        ctx.logger.warn(
          { attempt, error: errorObj.message },
          "Step failed, retrying...",
        );
        await sleep(step.retry.delay_ms);
        lastError = errorObj;
        continue;
      }
      return {
        step_index: ctx.stepIndex,
        step_id: stepId,
        action: step.action,
        description: step.description,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        attempt,
        max_attempts: maxAttempts,
        result: "failure",
        pre_state: preState,
        post_state: null,
        assertions: [],
        error: errorObj,
      };
    }

    // If handler returned failure
    if (!result.success) {
      if (attempt < maxAttempts) {
        ctx.logger.warn(
          { attempt, error: result.error?.message },
          "Step failed, retrying...",
        );
        await sleep(step.retry.delay_ms);
        lastError = result.error;
        continue;
      }
      return {
        step_index: ctx.stepIndex,
        step_id: stepId,
        action: step.action,
        description: step.description,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        attempt,
        max_attempts: maxAttempts,
        result: "failure",
        pre_state: preState,
        post_state: null,
        assertions: [],
        error: result.error,
      };
    }

    // Merge extracted variables
    if (result.extracted) {
      for (const [key, value] of Object.entries(result.extracted)) {
        ctx.variables.set(key, value);
      }
    }

    // Post-state capture (skip during cursor/recording mode to avoid flicker)
    let postState: Snapshot | null = null;
    if (!ctx.cursorAnimator && (step.screenshot === "after" || step.screenshot === "both")) {
      postState = await ctx.observer
        .captureSnapshot(
          ctx.page,
          `${String(ctx.stepIndex).padStart(2, "0")}-${step.action}-after`,
        )
        .catch(() => null);
    }

    // Run assertions
    let assertionResults: AssertionResult[] = [];
    if (step.assertions.length > 0) {
      assertionResults = await assertionEngine.evaluateAll(
        step.assertions,
        ctx.page,
      );
      const allPassed = assertionResults.every((r) => r.passed);

      for (const ar of assertionResults) {
        if (ar.passed) {
          ctx.logger.info({ assertion: ar.assertion.type }, `Assertion PASSED: ${ar.message}`);
        } else {
          ctx.logger.warn({ assertion: ar.assertion.type }, `Assertion FAILED: ${ar.message}`);
        }
      }

      if (!allPassed) {
        if (attempt < maxAttempts) {
          ctx.logger.warn("Assertions failed, retrying...");
          await sleep(step.retry.delay_ms);
          lastAssertions = assertionResults;
          continue;
        }
        return {
          step_index: ctx.stepIndex,
          step_id: stepId,
          action: step.action,
          description: step.description,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startMs,
          attempt,
          max_attempts: maxAttempts,
          result: "failure",
          pre_state: preState,
          post_state: postState,
          assertions: assertionResults,
          error: {
            code: "ASSERTION_FAILED",
            message: assertionResults
              .filter((r) => !r.passed)
              .map((r) => r.message)
              .join("; "),
          },
        };
      }
    }

    // Success
    ctx.logger.info(
      { stepId, duration_ms: Date.now() - startMs },
      `[step ${ctx.stepIndex}] ${step.action} — SUCCESS`,
    );

    return {
      step_index: ctx.stepIndex,
      step_id: stepId,
      action: step.action,
      description: step.description,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      attempt,
      max_attempts: maxAttempts,
      result: "success",
      pre_state: preState,
      post_state: postState,
      assertions: assertionResults,
    };
  }

  // Should not reach here, but just in case
  return {
    step_index: ctx.stepIndex,
    step_id: stepId,
    action: step.action,
    description: step.description,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 0,
    attempt: maxAttempts,
    max_attempts: maxAttempts,
    result: "failure",
    pre_state: null,
    post_state: null,
    assertions: lastAssertions,
    error: lastError ?? { code: "UNKNOWN", message: "Exhausted retries" },
  };
}

export async function executePlan(
  plan: Plan,
  options: ExecutorOptions,
): Promise<RunSummary> {
  const traceStore = new TraceStore(options.traceDir);
  await traceStore.init(plan);

  const logger = createLogger(traceStore.runDir, options.verbose);
  logger.info({ plan: plan.metadata.name, steps: plan.steps.length }, "Starting plan execution");

  const browserManager = new BrowserManager();
  const { context, page } = await browserManager.launch({
    headless: options.headless,
    viewport: plan.metadata.screen,
    slowMo: options.slowMo > 0 ? options.slowMo : undefined,
  });

  const targetResolver = new TargetResolverImpl();
  const observer = new Observer(traceStore.runDir);
  const assertionEngine = new AssertionEngine(targetResolver);

  // Initialize cursor animator if --cursor flag is set
  let cursorAnimator: CursorAnimator | undefined;
  if (options.cursor) {
    cursorAnimator = new CursorAnimator(options.cursorSpeed);
    await cursorAnimator.init();
    logger.info("Cursor animation enabled");
  }

  const ctx: ExecutionContext = {
    page,
    browserContext: context,
    observer,
    targetResolver,
    traceStore,
    logger,
    variables: new Map(),
    stepIndex: 0,
    aborted: false,
    cursorAnimator,
  };

  const stepLogs: StepLog[] = [];
  const planStartedAt = new Date().toISOString();
  const planStartMs = Date.now();
  const planDeadline = planStartMs + plan.metadata.timeout_ms;

  // Determine which steps to run
  const stepsToRun =
    options.singleStep !== undefined
      ? [{ step: plan.steps[options.singleStep], index: options.singleStep }]
      : plan.steps.map((step, index) => ({ step, index }));

  for (const { step, index } of stepsToRun) {
    if (ctx.aborted) break;

    if (Date.now() > planDeadline) {
      logger.error("Plan timeout exceeded — aborting");
      ctx.aborted = true;
      break;
    }

    ctx.stepIndex = index;
    const stepLog = await executeStep(step, ctx, assertionEngine);
    stepLogs.push(stepLog);
    await traceStore.writeStepLog(stepLog);

    if (stepLog.result === "failure") {
      ctx.aborted = true;
    }
  }

  await browserManager.close();

  const completedAt = new Date().toISOString();
  const passedSteps = stepLogs.filter((s) => s.result === "success").length;
  const failedSteps = stepLogs.filter((s) => s.result === "failure").length;

  const summary: RunSummary = {
    run_id: traceStore.runId,
    trace_dir: traceStore.runDir,
    plan_name: plan.metadata.name,
    started_at: planStartedAt,
    completed_at: completedAt,
    duration_ms: Date.now() - planStartMs,
    total_steps: stepsToRun.length,
    passed_steps: passedSteps,
    failed_steps: failedSteps,
    result: ctx.aborted
      ? failedSteps > 0
        ? "failure"
        : "aborted"
      : "success",
    steps: stepLogs,
  };

  await traceStore.finalize(summary);
  logger.info(
    { result: summary.result, passed: passedSteps, failed: failedSteps },
    "Plan execution complete",
  );

  return summary;
}
