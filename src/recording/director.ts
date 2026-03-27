import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionLogEntry } from "./action-log.js";

export interface ZoomRegion {
  startSec: number;
  endSec: number;
  zoomLevel: number;
  cx: number;
  cy: number;
  reason: string;
}

/**
 * Post-recording director pass: reviews screenshots + action log
 * and decides where to place zoom regions.
 */
export async function runDirector(options: {
  traceDir: string;
  actionLogPath: string;
  model?: string;
}): Promise<ZoomRegion[]> {
  const client = new Anthropic();
  const model = options.model || "claude-sonnet-4-20250514";

  // Load action log
  const entries: ActionLogEntry[] = JSON.parse(
    readFileSync(options.actionLogPath, "utf-8"),
  );

  // Find screenshots directory
  const ssDir = join(options.traceDir, "screenshots");
  if (!existsSync(ssDir)) return [];

  // Pick key screenshots: one per action (not screenshots/waits)
  const actionEntries = entries.filter(
    (e) => e.type === "action" && e.action !== "screenshot" && e.action !== "wait",
  );

  // Send up to 15 screenshots so the director sees all important moments
  const maxSamples = 15;
  const step = Math.max(1, Math.floor(actionEntries.length / maxSamples));
  const sampled = actionEntries.filter((_, i) => i % step === 0).slice(0, maxSamples);

  // Find matching screenshot files
  const ssFiles = existsSync(ssDir) ? readdirSync(ssDir).sort() : [];

  // Build message content with screenshots + descriptions
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  content.push({
    type: "text",
    text: `You are a video director reviewing screenshots from a product demo recording. Decide which moments deserve a camera zoom-in and where to focus.

The recording is ${((entries[entries.length - 1]?.t || 0) / 1000).toFixed(0)} seconds long at 1024x768 resolution.

Here are key moments from the recording:`,
  });

  for (const entry of sampled) {
    const timeSec = entry.t / 1000;
    const desc = `${entry.action || "action"}${entry.coords ? ` at (${entry.coords[0]}, ${entry.coords[1]})` : ""}`;

    // Find the closest screenshot
    const actionIdx = entries.indexOf(entry);
    const ssPrefix = String(
      entries.filter((e) => e.type === "action").indexOf(entry) + 1,
    ).padStart(3, "0");
    const ssFile = ssFiles.find((f) => f.startsWith(ssPrefix));

    content.push({
      type: "text",
      text: `\n--- ${timeSec.toFixed(1)}s: ${desc} ---`,
    });

    if (ssFile) {
      const ssPath = join(ssDir, ssFile);
      try {
        const b64 = readFileSync(ssPath).toString("base64");
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: b64 },
        });
      } catch {}
    }
  }

  content.push({
    type: "text",
    text: `
Based on these screenshots, return a JSON array of zoom regions. Each region:
- startSec: when to start zooming (seconds)
- endSec: when to stop zooming
- zoomLevel: 1.5 to 3.0 (how much to zoom in)
- cx: x coordinate to center the zoom on (0-1024)
- cy: y coordinate to center the zoom on (0-768)
- reason: brief description of why this moment deserves a zoom

Rules:
- Zoom on every moment that matters: form interactions, button clicks, important UI elements appearing, key content being revealed, text being typed, meaningful state changes
- Don't zoom on: page loads with no visible change, idle/waiting moments, repeated similar actions
- Each zoom should last 1-3 seconds
- Zoom level 1.5 is standard (subtle, cinematic). Use 1.8-2.0 only for very small UI elements. Never exceed 2.5

Respond with ONLY the JSON array, no markdown fences.`,
  });

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: content as unknown as Anthropic.MessageParam["content"] }],
  });

  // Parse response
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    // Extract JSON from response
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
    }
    const braceStart = jsonStr.indexOf("[");
    const braceEnd = jsonStr.lastIndexOf("]");
    if (braceStart !== -1 && braceEnd > braceStart) {
      jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
    }

    const regions: ZoomRegion[] = JSON.parse(jsonStr);
    return regions.filter(
      (r) =>
        typeof r.startSec === "number" &&
        typeof r.endSec === "number" &&
        typeof r.zoomLevel === "number" &&
        typeof r.cx === "number" &&
        typeof r.cy === "number" &&
        r.endSec > r.startSec,
    );
  } catch {
    console.log("  Director: failed to parse zoom regions from LLM response");
    return [];
  }
}
