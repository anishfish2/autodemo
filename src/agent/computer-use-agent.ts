import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { Logger } from "pino";
import type { AgentOptions, AgentResult } from "./agent-types.js";
import type { EventLogger } from "../recording/event-logger.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { Observer } from "../observer/observer.js";
import { AgentTraceStore } from "./agent-trace.js";
import { createLogger } from "../trace/logger.js";
import { CursorAnimator } from "../util/cursor-animator.js";

interface ComputerToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
  >;
}

async function takeScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: "png" });
  return buffer.toString("base64");
}

async function executeComputerAction(
  action: string,
  input: Record<string, unknown>,
  page: Page,
  logger: Logger,
  cursorAnimator?: CursorAnimator,
  eventLogger?: EventLogger,
): Promise<string> {
  switch (action) {
    case "screenshot": {
      // Handled separately — we return the image in the tool result
      return "__screenshot__";
    }

    case "left_click": {
      const [x, y] = input.coordinate as [number, number];
      logger.info(`Computer use: left_click at (${x}, ${y})`);
      if (cursorAnimator) {
        // Log cursor movement for recording
        const resolved = { kind: "coordinates" as const, x, y };
        await cursorAnimator.moveToElement(resolved, page);
      }
      eventLogger?.logClick(x, y, "left");
      await page.mouse.click(x, y);
      return "Clicked";
    }

    case "right_click": {
      const [x, y] = input.coordinate as [number, number];
      logger.info({ x, y }, "Computer use: right_click");
      if (cursorAnimator) {
        const resolved = { kind: "coordinates" as const, x, y };
        await cursorAnimator.moveToElement(resolved, page);
      }
      eventLogger?.logClick(x, y, "right");
      await page.mouse.click(x, y, { button: "right" });
      return "Right-clicked";
    }

    case "double_click": {
      const [x, y] = input.coordinate as [number, number];
      logger.info({ x, y }, "Computer use: double_click");
      if (cursorAnimator) {
        const resolved = { kind: "coordinates" as const, x, y };
        await cursorAnimator.moveToElement(resolved, page);
      }
      eventLogger?.logClick(x, y, "left");
      await page.mouse.dblclick(x, y);
      return "Double-clicked";
    }

    case "mouse_move": {
      const [x, y] = input.coordinate as [number, number];
      logger.info({ x, y }, "Computer use: mouse_move");
      if (cursorAnimator) {
        const resolved = { kind: "coordinates" as const, x, y };
        await cursorAnimator.moveToElement(resolved, page);
      }
      await page.mouse.move(x, y);
      return "Mouse moved";
    }

    case "type": {
      const text = input.text as string;
      logger.info({ text: text.slice(0, 50) }, "Computer use: type");
      await page.keyboard.type(text);
      return "Typed text";
    }

    case "key": {
      const key = input.key as string;
      logger.info({ key }, "Computer use: key");
      // Convert computer use key format to Playwright format
      // e.g., "ctrl+a" → "Control+a", "Return" → "Enter"
      const mapped = key
        .replace(/\bctrl\b/gi, "Control")
        .replace(/\bcmd\b/gi, "Meta")
        .replace(/\bcommand\b/gi, "Meta")
        .replace(/\balt\b/gi, "Alt")
        .replace(/\bshift\b/gi, "Shift")
        .replace(/\bReturn\b/g, "Enter")
        .replace(/\bspace\b/gi, " ")
        .replace(/\bBackSpace\b/g, "Backspace");
      await page.keyboard.press(mapped);
      return `Pressed ${key}`;
    }

    case "scroll": {
      const [x, y] = (input.coordinate as [number, number]) ?? [
        960, 540,
      ];
      const direction = input.scroll_direction as string;
      const amount = (input.scroll_amount as number) ?? 3;
      const px = amount * 100;
      logger.info({ x, y, direction, amount }, "Computer use: scroll");

      if (cursorAnimator) {
        const resolved = { kind: "coordinates" as const, x, y };
        await cursorAnimator.moveToElement(resolved, page);
      }

      await page.mouse.move(x, y);
      switch (direction) {
        case "down":
          await page.mouse.wheel(0, px);
          break;
        case "up":
          await page.mouse.wheel(0, -px);
          break;
        case "right":
          await page.mouse.wheel(px, 0);
          break;
        case "left":
          await page.mouse.wheel(-px, 0);
          break;
      }
      return `Scrolled ${direction}`;
    }

    case "wait": {
      const ms = ((input.duration as number) ?? 1) * 1000;
      logger.info({ ms }, "Computer use: wait");
      await new Promise((r) => setTimeout(r, ms));
      return "Waited";
    }

    default:
      logger.warn({ action }, "Unknown computer use action");
      return `Unknown action: ${action}`;
  }
}

export async function runComputerUseAgent(
  options: AgentOptions,
): Promise<AgentResult> {
  const agentTrace = new AgentTraceStore(options.traceDir);
  await agentTrace.init(options.task);

  const logger = createLogger(agentTrace.runDir, options.verbose);
  logger.info({ task: options.task }, "Computer use agent starting");

  const client = new Anthropic();

  // Use 1280x800 viewport for computer use — Claude's vision model is more
  // accurate with smaller images. The video gets upscaled in post if needed.
  const cuViewport = { width: 1280, height: 800 };

  const browserManager = new BrowserManager();
  const { page } = await browserManager.launch({
    headless: options.headless,
    viewport: cuViewport,
    slowMo: options.slowMo > 0 ? options.slowMo : undefined,
    recordVideoDir: options.recordVideoDir,
  });

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
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to navigate to start URL",
      );
    });
  }

  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  const agentStartMs = Date.now();
  const deadline = agentStartMs + options.totalTimeoutMs;

  // Select tool version based on model
  const isOpus = options.model.includes("opus");
  const toolVersion = isOpus ? "computer_20251124" : "computer_20250124";
  const betaFlag = isOpus
    ? "computer-use-2025-11-24"
    : "computer-use-2025-01-24";

  const tools: Anthropic.Beta.BetaToolUnion[] = [
    {
      type: toolVersion,
      name: "computer",
      display_width_px: viewport.width,
      display_height_px: viewport.height,
    } as Anthropic.Beta.BetaToolComputerUse20251124,
  ];

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `${options.task}\n\nAfter each action, take a screenshot to verify the result before proceeding. When the task is fully complete, respond with a text message describing what was accomplished.`,
    },
  ];

  let totalStepsExecuted = 0;
  let iterations = 0;
  let finalResult: AgentResult["result"] = "max_iterations";
  let finalMessage: string | undefined;

  try {
    while (iterations < options.maxIterations) {
      if (Date.now() > deadline) {
        logger.warn("Agent total timeout exceeded");
        finalResult = "timeout";
        break;
      }

      iterations++;
      logger.info({ iteration: iterations }, `--- Iteration ${iterations} ---`);

      const response = await client.beta.messages.create({
        model: options.model,
        max_tokens: 4096,
        tools,
        messages,
        betas: [betaFlag],
      });

      // Add assistant response to conversation
      messages.push({ role: "assistant", content: response.content });

      // Log Claude's thinking (text blocks explain its reasoning)
      const textBlocks = response.content.filter(
        (block): block is Anthropic.Beta.BetaTextBlock =>
          block.type === "text",
      );
      for (const tb of textBlocks) {
        console.log(`\n  [Claude] ${tb.text}`);
      }

      // Check if Claude is done (no tool use)
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock =>
          block.type === "tool_use",
      );

      if (toolUseBlocks.length === 0) {
        finalMessage = textBlocks.map((b) => b.text).join("\n");
        finalResult = "success";
        logger.info({ message: finalMessage?.slice(0, 100) }, "Task complete");
        break;
      }

      // Execute each tool use request
      const toolResults: ComputerToolResult[] = [];

      for (const toolBlock of toolUseBlocks) {
        const input = toolBlock.input as Record<string, unknown>;
        const action = input.action as string;

        totalStepsExecuted++;

        // Log the full action details so user can see what Claude is doing
        const coord = input.coordinate as [number, number] | undefined;
        const actionDesc = coord
          ? `${action} at (${coord[0]}, ${coord[1]})`
          : action === "type"
            ? `type "${(input.text as string)?.slice(0, 40)}"`
            : action === "key"
              ? `key "${input.key}"`
              : action === "scroll"
                ? `scroll ${input.scroll_direction} ${input.scroll_amount ?? 3}`
                : action;
        console.log(`  [Action] ${actionDesc}`);

        if (action === "screenshot") {
          // Return screenshot
          const screenshot = await takeScreenshot(page);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: screenshot,
                },
              },
            ],
          });
          logger.info("Screenshot taken");
        } else {
          // Execute the action
          try {
            const result = await executeComputerAction(
              action,
              input,
              page,
              logger,
              cursorAnimator,
              options.eventLogger,
            );

            // After any action, also take a screenshot so Claude can see the result
            const screenshot = await takeScreenshot(page);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: [
                { type: "text", text: result },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: screenshot,
                  },
                },
              ],
            });
          } catch (err) {
            const errorMsg =
              err instanceof Error ? err.message : String(err);
            logger.error({ action, error: errorMsg }, "Action failed");
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: [{ type: "text", text: `Error: ${errorMsg}` }],
            });
          }
        }
      }

      // Add tool results to conversation
      messages.push({
        role: "user",
        content: toolResults as Anthropic.Beta.BetaContentBlockParam[],
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    finalResult = "failure";
    finalMessage = `Fatal error: ${errorMsg}`;
    logger.error({ error: errorMsg }, "Agent crashed");
  }

  await browserManager.close();

  const result: AgentResult = {
    taskDescription: options.task,
    result: finalResult,
    totalIterations: iterations,
    totalStepsExecuted,
    totalDurationMs: Date.now() - agentStartMs,
    iterations: [],
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
    "Computer use agent complete",
  );

  return result;
}
