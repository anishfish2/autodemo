import Anthropic from "@anthropic-ai/sdk";
import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { AgentOptions, AgentResult } from "./agent-types.js";
import { ActionLog } from "../recording/action-log.js";
import { autoEdit } from "../recording/auto-editor.js";
import { runDirector } from "../recording/director.js";

const execFileAsync = promisify(execFile);

// --- State ---
let cursorX = 0;
let cursorY = 0;
let activeDisplayId = 1; // macOS display number for screencapture -D

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Smoothly animate the real system cursor from current position to target
 * along a bezier arc with ease-out timing. Uses CGEventCreateMouseEvent
 * for proper mouse move events (smooth, not teleporting) and runs the
 * entire animation in a single osascript call to eliminate per-step overhead.
 */
async function animateCursorTo(
  targetX: number,
  targetY: number,
  durationMs = 600,
): Promise<void> {
  const startX = cursorX;
  const startY = cursorY;
  const dist = Math.sqrt((targetX - startX) ** 2 + (targetY - startY) ** 2);
  if (dist < 3) { cursorX = targetX; cursorY = targetY; return; }

  // Scale duration with distance — short moves are faster
  const adjustedDuration = Math.max(250, Math.min(durationMs, dist * 1.5));
  const steps = Math.max(20, Math.round(adjustedDuration / 12)); // ~80fps for smooth motion
  const delayMs = adjustedDuration / steps;

  // Bezier control point for arc
  const mx = (startX + targetX) / 2;
  const my = (startY + targetY) / 2;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const arcOffset = dist * 0.1;
  const ctrlX = mx + (-dy / len) * arcOffset;
  const ctrlY = my + (dx / len) * arcOffset;

  // Run entire animation in a single osascript process
  // Uses CGEventCreateMouseEvent for proper mouse move events
  await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('CoreGraphics');
     ObjC.import('Cocoa');
     const steps = ${steps};
     const stepDelay = ${delayMs / 1000};
     const sx = ${startX}, sy = ${startY};
     const cx = ${ctrlX}, cy = ${ctrlY};
     const tx = ${targetX}, ty = ${targetY};

     for (let i = 1; i <= steps; i++) {
       // Ease-out cubic
       const raw = i / steps;
       const t = 1 - Math.pow(1 - raw, 3);
       const u = 1 - t;
       const x = u * u * sx + 2 * u * t * cx + t * t * tx;
       const y = u * u * sy + 2 * u * t * cy + t * t * ty;

       const p = $.CGPointMake(x, y);
       const ev = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, 0);
       $.CGEventPost($.kCGHIDEventTap, ev);
       $.NSThread.sleepForTimeInterval(stepDelay);
     }`,
  ]);

  cursorX = targetX;
  cursorY = targetY;
}

// --- System-level primitives ---

async function takeScreenshot(path: string, screenW: number, screenH: number): Promise<string> {
  const rawPath = path.replace(".png", "-raw.png");
  execSync(`screencapture -x -C -D ${activeDisplayId} ${rawPath}`);
  // Resize to EXACT target dimensions (stretch to fit, not aspect-preserving)
  // This ensures the image matches display_width_px x display_height_px exactly
  execSync(
    `ffmpeg -y -i ${rawPath} -vf "scale=${screenW}:${screenH}" ${path} 2>/dev/null`,
  );
  return readFileSync(path).toString("base64");
}

async function mouseClick(x: number, y: number): Promise<void> {
  // Animate cursor to target with smooth arc, then click
  await animateCursorTo(x, y);
  await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('CoreGraphics');
     const p = $.CGPointMake(${x}, ${y});
     const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft);
     const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft);
     $.CGEventPost($.kCGHIDEventTap, down);
     $.CGEventPost($.kCGHIDEventTap, up);`,
  ]);
}

async function mouseDoubleClick(x: number, y: number): Promise<void> {
  await animateCursorTo(x, y);
  await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('CoreGraphics');
     const p = $.CGPointMake(${x}, ${y});
     const d1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft);
     const u1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft);
     const d2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft);
     const u2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft);
     $.CGEventSetIntegerValueField(d2, $.kCGMouseEventClickState, 2);
     $.CGEventSetIntegerValueField(u2, $.kCGMouseEventClickState, 2);
     $.CGEventPost($.kCGHIDEventTap, d1);
     $.CGEventPost($.kCGHIDEventTap, u1);
     $.CGEventPost($.kCGHIDEventTap, d2);
     $.CGEventPost($.kCGHIDEventTap, u2);`,
  ]);
}

async function mouseMove(x: number, y: number): Promise<void> {
  await animateCursorTo(x, y, 300);
}

async function mouseScroll(
  x: number,
  y: number,
  direction: string,
  amount: number,
): Promise<void> {
  await mouseMove(x, y);
  // Send multiple small scroll events for smooth, visible scrolling
  const perStep = direction === "down" ? -3 : direction === "up" ? 3 : 0;
  const perStepX = direction === "right" ? -3 : direction === "left" ? 3 : 0;
  const steps = Math.max(amount, 3);
  for (let i = 0; i < steps; i++) {
    await execFileAsync("osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import('CoreGraphics');
       const e = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${perStep}, ${perStepX});
       $.CGEventPost($.kCGHIDEventTap, e);`,
    ]);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function typeText(text: string): Promise<void> {
  // Use AppleScript to type — handles special characters
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await execFileAsync("osascript", [
    "-e",
    `tell application "System Events" to keystroke "${escaped}"`,
  ]);
}

async function pressKey(key: string): Promise<void> {
  // Map common key names to AppleScript key codes
  const keyMap: Record<string, string> = {
    Return: "return",
    Enter: "return",
    Tab: "tab",
    Escape: "escape",
    Backspace: "delete",
    Delete: "delete",
    " ": "space",
    space: "space",
  };

  // Handle modifier combos like "ctrl+a", "cmd+c"
  const parts = key.split("+").map((k) => k.trim());
  const modifiers: string[] = [];
  let mainKey = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "ctrl" || mod === "control") modifiers.push("control down");
    else if (mod === "cmd" || mod === "command" || mod === "meta")
      modifiers.push("command down");
    else if (mod === "alt" || mod === "option") modifiers.push("option down");
    else if (mod === "shift") modifiers.push("shift down");
  }

  const mapped = keyMap[mainKey] || mainKey;
  const modStr =
    modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

  if (mapped.length === 1) {
    await execFileAsync("osascript", [
      "-e",
      `tell application "System Events" to keystroke "${mapped}"${modStr}`,
    ]);
  } else {
    // Use key code for special keys
    const codeMap: Record<string, number> = {
      return: 36,
      tab: 48,
      escape: 53,
      delete: 51,
      space: 49,
      up: 126,
      down: 125,
      left: 123,
      right: 124,
    };
    const code = codeMap[mapped.toLowerCase()];
    if (code !== undefined) {
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to key code ${code}${modStr}`,
      ]);
    }
  }
}

async function openUrl(url: string): Promise<void> {
  await execFileAsync("open", ["-a", "Google Chrome", url]);
  await new Promise((r) => setTimeout(r, 2000));
}

// --- Screen dimensions ---

async function getScreenSize(): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const f = s.frame; JSON.stringify({w:Math.round(f.size.width), h:Math.round(f.size.height)})`,
  ]);
  return JSON.parse(stdout.trim());
}

// --- Main agent ---

export async function runNativeComputerUseAgent(
  options: AgentOptions,
): Promise<AgentResult> {
  const runId = `agent_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${nanoid(6)}`;
  const traceDir = join(options.traceDir, runId);
  mkdirSync(join(traceDir, "screenshots"), { recursive: true });

  const physicalScreen = await getScreenSize();
  // Use 1024x768 for computer use — Claude is most accurate at this resolution
  const screen = { w: 1024, h: 768 };
  console.log(`Physical screen: ${physicalScreen.w}x${physicalScreen.h}, Computer use: ${screen.w}x${screen.h}`);

  const client = new Anthropic();

  // Navigate to start URL
  if (options.startUrl) {
    console.log(`Opening ${options.startUrl}...`);
    await openUrl(options.startUrl);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Start FFmpeg screen recording — detect which screen Chrome is on
  let ffmpegProcess: ChildProcess | null = null;
  const videoPath = join(traceDir, "recording.mp4");
  {
    const deviceIndex = await findScreenDeviceForChrome();
    console.log(`Recording screen device: ${deviceIndex}`);
    ffmpegProcess = spawn("ffmpeg", [
      "-y",
      "-f", "avfoundation",
      "-framerate", "30",
      "-capture_cursor", "1",
      "-capture_mouse_clicks", "1",
      "-i", `${deviceIndex}:none`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-crf", "18",
      videoPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((r) => setTimeout(r, 1000));
    console.log("Recording started");
  }

  // Select tool version
  const isOpus = options.model.includes("opus");
  const toolVersion = isOpus ? "computer_20251124" : "computer_20250124";
  const betaFlag = isOpus
    ? "computer-use-2025-11-24"
    : "computer-use-2025-01-24";

  // Scale factor: Claude thinks in 1024x768, real screen is physicalScreen
  const scaleX = physicalScreen.w / screen.w;
  const scaleY = physicalScreen.h / screen.h;

  const tools: Anthropic.Beta.BetaToolUnion[] = [
    {
      type: toolVersion,
      name: "computer",
      display_width_px: screen.w,
      display_height_px: screen.h,
      ...(isOpus ? { enable_zoom: true } : {}),
    } as Anthropic.Beta.BetaToolComputerUse20251124,
  ];

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `${options.task}\n\nIMPORTANT: After each action, take a screenshot to verify the result. If a click didn't hit the intended target (nothing changed, wrong element activated), use the zoom action to inspect the area more closely, then retry with adjusted coordinates. When the task is fully complete, respond with a text message describing what was accomplished.`,
    },
  ];

  const actionLog = new ActionLog();

  let totalStepsExecuted = 0;
  let iterations = 0;
  const agentStartMs = Date.now();
  const deadline = agentStartMs + options.totalTimeoutMs;
  let finalResult: AgentResult["result"] = "max_iterations";
  let finalMessage: string | undefined;

  try {
    while (iterations < options.maxIterations) {
      if (Date.now() > deadline) {
        finalResult = "timeout";
        break;
      }

      iterations++;
      console.log(`\n--- Iteration ${iterations} ---`);

      actionLog.log({ type: "llm_start", iteration: iterations });

      const response = await client.beta.messages.create({
        model: options.model,
        max_tokens: 4096,
        tools,
        messages,
        betas: [betaFlag],
      });

      // Extract thinking text
      const thinkingText = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .slice(0, 100);

      actionLog.log({
        type: "llm_end",
        iteration: iterations,
        thinking: thinkingText,
      });

      messages.push({ role: "assistant", content: response.content });

      // Log thinking
      for (const block of response.content) {
        if (block.type === "text") {
          console.log(`  [Claude] ${block.text}`);
        }
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0) {
        const texts = response.content.filter(
          (b): b is Anthropic.Beta.BetaTextBlock => b.type === "text",
        );
        finalMessage = texts.map((b) => b.text).join("\n");
        finalResult = "success";
        console.log(`\n  [Done] ${finalMessage?.slice(0, 200)}`);
        break;
      }

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: unknown;
      }> = [];

      for (const toolBlock of toolUseBlocks) {
        const input = toolBlock.input as Record<string, unknown>;
        const action = input.action as string;
        totalStepsExecuted++;

        const coord = input.coordinate as [number, number] | undefined;
        const desc = coord
          ? `${action} at (${coord[0]}, ${coord[1]})`
          : action === "type"
            ? `type "${(input.text as string)?.slice(0, 40)}"`
            : action === "key"
              ? `key "${input.key}"`
              : action === "scroll"
                ? `scroll ${input.scroll_direction} ${input.scroll_amount ?? 3}`
                : action;
        console.log(`  [Action] ${desc}`);

        actionLog.log({
          type: "action",
          action,
          coords: coord as [number, number] | undefined,
        });

        try {
          const screenshotPath = join(
            traceDir,
            "screenshots",
            `${String(totalStepsExecuted).padStart(3, "0")}-${action}.png`,
          );

          if (action === "screenshot") {
            actionLog.log({ type: "screenshot" });
            const b64 = await takeScreenshot(screenshotPath, screen.w, screen.h);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: b64 },
                },
              ],
            });
          } else if (action === "zoom") {
            // Zoom action (Opus only) — take full screenshot, crop region with ffmpeg
            const region = input.region as [number, number, number, number];
            console.log(`  [Zoom] region (${region.join(", ")})`);
            try {
              const rawPath = screenshotPath.replace(".png", "-full.png");
              execSync(`screencapture -x -C -D ${activeDisplayId} ${rawPath}`);
              // Use ffmpeg to crop — more reliable than sips
              const [x1, y1, x2, y2] = region;
              // Scale from 1024x768 to Retina physical pixels
              const retina = 2;
              const cx = Math.round(x1 * scaleX * retina);
              const cy = Math.round(y1 * scaleY * retina);
              const cw = Math.round((x2 - x1) * scaleX * retina);
              const ch = Math.round((y2 - y1) * scaleY * retina);
              execSync(
                `ffmpeg -y -i ${rawPath} -vf "crop=${cw}:${ch}:${cx}:${cy},scale=1024:-1" ${screenshotPath} 2>/dev/null`,
              );
              const b64 = readFileSync(screenshotPath).toString("base64");
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolBlock.id,
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: b64 },
                  },
                ],
              });
            } catch (zoomErr) {
              // Zoom failed — fall back to regular screenshot
              console.log(`  [Zoom failed, sending regular screenshot]`);
              const b64 = await takeScreenshot(screenshotPath, screen.w, screen.h);
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolBlock.id,
                content: [
                  { type: "text", text: "Zoom failed, here is the full screenshot instead" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: b64 },
                  },
                ],
              });
            }
          } else {
            // Scale coordinates from 1024x768 to physical screen
            const physX = coord ? Math.round(coord[0] * scaleX) : undefined;
            const physY = coord ? Math.round(coord[1] * scaleY) : undefined;

            // Execute the action at physical coordinates
            switch (action) {
              case "left_click":
                await mouseClick(physX!, physY!);
                break;
              case "right_click":
                await mouseClick(physX!, physY!);
                break;
              case "double_click":
                await mouseDoubleClick(physX!, physY!);
                break;
              case "mouse_move":
                await mouseMove(physX!, physY!);
                break;
              case "type":
                await typeText(input.text as string);
                break;
              case "key":
                await pressKey(input.key as string);
                break;
              case "scroll":
                await mouseScroll(
                  physX ?? Math.round(physicalScreen.w / 2),
                  physY ?? Math.round(physicalScreen.h / 2),
                  input.scroll_direction as string,
                  (input.scroll_amount as number) ?? 3,
                );
                break;
              case "wait":
                await new Promise((r) =>
                  setTimeout(r, ((input.duration as number) ?? 1) * 1000),
                );
                break;
              default:
                console.log(`  [Unknown action: ${action}]`);
            }

            actionLog.log({ type: "action_done" });

            // Take screenshot after action
            await new Promise((r) => setTimeout(r, 500));
            actionLog.log({ type: "screenshot" });
            const b64 = await takeScreenshot(screenshotPath, screen.w, screen.h);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: [
                { type: "text", text: `${action} executed` },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: b64 },
                },
              ],
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  [Error] ${msg}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: [{ type: "text", text: `Error: ${msg}` }],
          });
        }
      }

      messages.push({
        role: "user",
        content: toolResults as Anthropic.Beta.BetaContentBlockParam[],
      });
    }
  } catch (err) {
    finalResult = "failure";
    finalMessage = err instanceof Error ? err.message : String(err);
    console.error(`\n  [Fatal] ${finalMessage}`);
  }

  // Close the Chrome tab that was opened for recording
  try {
    execSync(
      `osascript -e 'tell application "Google Chrome" to close active tab of front window'`,
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {}

  // Save action log
  const actionLogPath = join(traceDir, "action-log.json");
  actionLog.save(actionLogPath);

  // Stop recording
  if (ffmpegProcess) {
    ffmpegProcess.stdin?.write("q");
    ffmpegProcess.stdin?.end();
    await new Promise((r) => setTimeout(r, 2000));

    // Re-encode with keyframe every frame for frame-accurate seeking in the editor
    const seekablePath = videoPath.replace(".mp4", "-seekable.mp4");
    console.log("Re-encoding for frame-accurate seeking...");
    try {
      execSync(
        `ffmpeg -y -i "${videoPath}" -c:v libx264 -preset fast -crf 18 -g 1 -keyint_min 1 -pix_fmt yuv420p -an "${seekablePath}" 2>/dev/null`,
      );
      // Replace original with seekable version
      execSync(`mv "${seekablePath}" "${videoPath}"`);
    } catch {
      console.log("  Re-encode failed — seeking may be limited");
    }
    console.log(`Raw video: ${videoPath}`);

    // Extract thumbnail from first meaningful frame (skip first 2 seconds of blank screen)
    try {
      const thumbPath = join(traceDir, "thumbnail.jpg");
      execSync(
        `ffmpeg -y -ss 3 -i "${videoPath}" -frames:v 1 -q:v 5 "${thumbPath}" 2>/dev/null`,
      );
    } catch {}

    // Director pass: LLM reviews screenshots and decides zoom regions
    console.log("Running director pass for zoom regions...");
    try {
      const zoomRegions = await runDirector({
        traceDir,
        actionLogPath,
        model: options.model,
      });
      if (zoomRegions.length > 0) {
        const zoomPath = join(traceDir, "zoom-regions.json");
        const { writeFileSync: wf } = await import("node:fs");
        wf(zoomPath, JSON.stringify(zoomRegions, null, 2));
        console.log(`  Director chose ${zoomRegions.length} zoom regions`);
        for (const z of zoomRegions) {
          console.log(`    ${z.startSec.toFixed(1)}s-${z.endSec.toFixed(1)}s ${z.zoomLevel}x at (${z.cx},${z.cy}) — ${z.reason}`);
        }
      } else {
        console.log("  Director: no zoom regions");
      }
    } catch (err) {
      console.log(`  Director pass failed: ${err instanceof Error ? err.message : err}`);
    }

    // Auto-edit: compress thinking time, keep actions at normal speed
    const editedPath = join(traceDir, "edited.mp4");
    try {
      await autoEdit({
        inputVideo: videoPath,
        actionLog: actionLogPath,
        outputVideo: editedPath,
      });
    } catch (err) {
      console.log(`  Auto-edit failed: ${err instanceof Error ? err.message : err}`);
      console.log(`  Raw video still available: ${videoPath}`);
    }
  }

  const result: AgentResult = {
    taskDescription: options.task,
    result: finalResult,
    totalIterations: iterations,
    totalStepsExecuted,
    totalDurationMs: Date.now() - agentStartMs,
    traceDir,
    finalMessage,
  };

  return result;
}

/**
 * Detect which macOS screen Chrome's front window is on,
 * then find the matching FFmpeg AVFoundation capture device.
 */
async function findScreenDeviceForChrome(): Promise<number> {
  // Step 1: Get Chrome window position
  let winX = 0;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "Google Chrome" to get bounds of front window',
    ]);
    const parts = stdout.trim().split(",").map((s: string) => parseInt(s.trim(), 10));
    if (parts.length >= 2) winX = parts[0];
  } catch {}

  // Step 2: Get screen positions to find which screen the window is on
  let screenIndex = 0;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-l", "JavaScript", "-e",
      `ObjC.import('AppKit');
       const screens = $.NSScreen.screens;
       const result = [];
       for (let i = 0; i < screens.count; i++) {
         const f = screens.objectAtIndex(i).frame;
         result.push({x: f.origin.x, w: f.size.width});
       }
       JSON.stringify(result)`,
    ]);
    const screens = JSON.parse(stdout.trim());
    // Find which screen contains the window's X position
    for (let i = 0; i < screens.length; i++) {
      const s = screens[i];
      if (winX >= s.x && winX < s.x + s.w) {
        screenIndex = i;
        break;
      }
    }
  } catch {}

  // Set the display ID for screencapture (1-based)
  activeDisplayId = screenIndex + 1;

  // Step 3: Find the FFmpeg device for "Capture screen N"
  const ffmpegOutput = (() => {
    try {
      return execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', { encoding: "utf-8" });
    } catch (err) {
      return (err as { stdout?: string }).stdout || "";
    }
  })();

  const regex = /\[(\d+)\] Capture screen (\d+)/g;
  let match;
  while ((match = regex.exec(ffmpegOutput)) !== null) {
    if (parseInt(match[2], 10) === screenIndex) {
      return parseInt(match[1], 10);
    }
  }

  // Fallback: try screen 0
  const fallback = ffmpegOutput.match(/\[(\d+)\] Capture screen 0/);
  if (fallback) return parseInt(fallback[1], 10);

  return 4; // Last resort
}
