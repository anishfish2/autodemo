import type {
  AgentOptions,
  AgentResult,
  AgentIteration,
  ChunkResult,
  LlmPlanResponse,
} from "./agent-types.js";
import type { ExecutionContext } from "../executor/executor.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { Observer } from "../observer/observer.js";
import { TargetResolver } from "../target/target-resolver.js";
import { TraceStore } from "../trace/trace-store.js";
import { createLogger } from "../trace/logger.js";
import { LlmClient } from "./llm-client.js";
import { PlanSynthesizer } from "./plan-synthesizer.js";
import { AgentTraceStore } from "./agent-trace.js";
import { extractPageContext } from "./page-context.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt-builder.js";
import { executeChunk } from "./chunk-executor.js";
import { CursorAnimator } from "../util/cursor-animator.js";
import { verifyAction } from "./action-verifier.js";

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  // Dispatch to native computer use agent if requested
  if (options.computerUse) {
    const { runNativeComputerUseAgent } = await import("./computer-use-native.js");
    return runNativeComputerUseAgent(options);
  }

  const agentTrace = new AgentTraceStore(options.traceDir);
  await agentTrace.init(options.task);

  const logger = createLogger(agentTrace.runDir, options.verbose);
  logger.info({ task: options.task }, "Agent starting");

  const llm = new LlmClient(options.model, logger);
  const synthesizer = new PlanSynthesizer(logger);

  const browserManager = new BrowserManager();
  const { context, page } = await browserManager.launch({
    headless: options.headless,
    viewport: { width: 1920, height: 1080 },
    slowMo: options.slowMo > 0 ? options.slowMo : undefined,
    recordVideoDir: options.recordVideoDir,
  });

  const observer = new Observer(agentTrace.runDir);
  const targetResolver = new TargetResolver();

  // Initialize cursor animator if --cursor flag is set
  let cursorAnimator: CursorAnimator | undefined;
  if (options.cursor) {
    cursorAnimator = new CursorAnimator(options.cursorSpeed, options.headless);
    await cursorAnimator.init();
    if (options.eventLogger) {
      cursorAnimator.eventLogger = options.eventLogger;
    }
    logger.info("Cursor animation enabled");
  }

  if (options.startUrl) {
    await page.goto(options.startUrl, { waitUntil: "load" }).catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to navigate to start URL");
    });
  }

  const iterations: AgentIteration[] = [];
  const conversationMessages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = [];
  const systemPrompt = buildSystemPrompt();

  let totalStepsExecuted = 0;
  let previousResult: ChunkResult | null = null;
  const agentStartMs = Date.now();
  const deadline = agentStartMs + options.totalTimeoutMs;

  let finalResult: AgentResult["result"] = "max_iterations";
  let finalMessage: string | undefined;
  let fatalError: string | undefined;

  try {

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    if (Date.now() > deadline) {
      logger.warn("Agent total timeout exceeded");
      finalResult = "timeout";
      break;
    }

    if (totalStepsExecuted >= options.maxTotalSteps) {
      logger.warn(
        { totalSteps: totalStepsExecuted },
        "Max total steps reached",
      );
      finalResult = "max_iterations";
      break;
    }

    logger.info({ iteration }, `--- Iteration ${iteration} ---`);

    // === OBSERVE ===
    const screenshotLabel = `iter-${String(iteration).padStart(2, "0")}-observe`;
    const screenshotPath = agentTrace.getScreenshotPath(screenshotLabel);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const pageContext = await extractPageContext(page, screenshotPath);

    logger.info(
      {
        url: pageContext.url,
        title: pageContext.title,
        elements: pageContext.elements.length,
      },
      "Page context extracted",
    );

    // === PLAN (LLM call) ===
    const userMessage = buildUserMessage(
      options.task,
      iteration,
      pageContext,
      previousResult,
    );
    conversationMessages.push(userMessage);

    let llmResult;
    try {
      llmResult = await llm.generatePlan(systemPrompt, conversationMessages);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "LLM call failed",
      );
      // Add a retry nudge
      conversationMessages.pop(); // Remove the failed user message
      if (iteration < options.maxIterations) {
        continue;
      }
      finalResult = "failure";
      break;
    }

    conversationMessages.push({
      role: "assistant",
      content: llmResult.content,
    });

    // Parse LLM response
    let parsed: LlmPlanResponse;
    try {
      parsed = synthesizer.parseResponse(llmResult.content);
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          raw: llmResult.content.slice(0, 500),
        },
        "Failed to parse LLM response",
      );
      // Push error message for self-correction
      conversationMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Your previous response could not be parsed as JSON. Error: ${err instanceof Error ? err.message : String(err)}. Please respond with a valid JSON object.`,
          },
        ],
      });
      continue;
    }

    logger.info(
      {
        status: parsed.status,
        stepCount: parsed.steps.length,
        thinking: parsed.thinking.slice(0, 200),
      },
      "LLM plan received",
    );

    // === CHECK TERMINAL STATES ===
    if (parsed.status === "task_complete") {
      finalResult = "success";
      finalMessage = parsed.completionMessage;
      logger.info(
        { message: parsed.completionMessage },
        "Task completed successfully",
      );

      iterations.push(
        buildIteration(iteration, pageContext, llmResult, parsed, null, null),
      );
      break;
    }

    if (parsed.status === "task_impossible") {
      finalResult = "impossible";
      finalMessage = parsed.impossibleReason;
      logger.warn(
        { reason: parsed.impossibleReason },
        "Task deemed impossible",
      );

      iterations.push(
        buildIteration(iteration, pageContext, llmResult, parsed, null, null),
      );
      break;
    }

    // No steps but continue?
    if (parsed.steps.length === 0) {
      logger.warn(
        "LLM returned 'continue' with no steps — nudging",
      );
      conversationMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "You returned 'continue' but provided no steps. Please provide the next steps, or set status to 'task_complete' if done.",
          },
        ],
      });
      continue;
    }

    // === EXECUTE ===
    const plan = synthesizer.buildChunkPlan(
      parsed.steps,
      options.task,
      iteration,
    );

    // Create a scoped trace store for this chunk's execution artifacts
    const chunkTraceStore = new TraceStore(agentTrace.getIterationDir(iteration));
    await chunkTraceStore.init(plan);

    const ctx: ExecutionContext = {
      page,
      browserContext: context,
      observer,
      targetResolver,
      traceStore: chunkTraceStore,
      logger,
      variables: new Map(),
      stepIndex: totalStepsExecuted,
      aborted: false,
      cursorAnimator,
    };

    const preUrl = page.url();
    const chunkResult = await executeChunk(plan, ctx, totalStepsExecuted);
    totalStepsExecuted += chunkResult.steps.length;

    // Deterministic post-action verification
    if (chunkResult.result === "success" && parsed.steps.length > 0) {
      const lastAction = parsed.steps[parsed.steps.length - 1];
      const verification = await verifyAction(lastAction, page, preUrl, logger);
      chunkResult.verification = verification.detail;
      if (!verification.passed) {
        logger.warn({ detail: verification.detail }, "Action verification failed");
      }
    }

    previousResult = chunkResult;

    logger.info(
      {
        result: chunkResult.result,
        stepsRun: chunkResult.steps.length,
        totalSteps: totalStepsExecuted,
      },
      `Chunk execution: ${chunkResult.result}`,
    );

    // Record iteration
    const agentIteration = buildIteration(
      iteration,
      pageContext,
      llmResult,
      parsed,
      plan,
      chunkResult,
    );
    iterations.push(agentIteration);
    await agentTrace.writeIteration(agentIteration);

    // === VERIFY ===
    // Loop continues — next iteration observes new state + sees previous result
  }

  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
    finalResult = "failure";
    finalMessage = `Fatal error: ${fatalError}`;
    logger.error({ error: fatalError }, "Agent crashed — cleaning up");
  }

  await browserManager.close();

  const result: AgentResult = {
    taskDescription: options.task,
    result: finalResult,
    totalIterations: iterations.length,
    totalStepsExecuted,
    totalDurationMs: Date.now() - agentStartMs,
    iterations,
    traceDir: agentTrace.runDir,
    finalMessage,
  };

  await agentTrace.finalize(result);

  logger.info(
    {
      result: result.result,
      iterations: result.totalIterations,
      steps: result.totalStepsExecuted,
      duration: result.totalDurationMs,
    },
    "Agent run complete",
  );

  return result;
}

function buildIteration(
  iteration: number,
  pageContext: import("./agent-types.js").PageContext,
  llmResult: { content: string; inputTokens: number; outputTokens: number; latencyMs: number } | null,
  parsed: LlmPlanResponse,
  plan: import("../schema/plan.js").Plan | null,
  chunkResult: ChunkResult | null,
): AgentIteration {
  return {
    iteration,
    timestamp: new Date().toISOString(),
    pageContext: {
      url: pageContext.url,
      title: pageContext.title,
      viewport: pageContext.viewport,
      elements: pageContext.elements as AgentIteration["pageContext"]["elements"],
      semantic: pageContext.semantic,
      screenshotPath: pageContext.screenshotPath,
    },
    llmResponse: {
      raw: llmResult?.content ?? "",
      parsed,
      tokensUsed: {
        input: llmResult?.inputTokens ?? 0,
        output: llmResult?.outputTokens ?? 0,
      },
      latencyMs: llmResult?.latencyMs ?? 0,
    },
    generatedPlan: plan,
    executionResult: chunkResult,
  };
}
