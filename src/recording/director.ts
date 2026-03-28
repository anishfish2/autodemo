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
 * Post-recording director pass: reviews screenshots from the action log
 * and picks zoom regions for the moments a viewer needs to notice.
 *
 * A moment is zoom-worthy when the viewer would miss something important
 * at full-screen scale. Two independent signals drive this:
 *
 * 1. VISUAL CHANGE — the screen looks substantially different after an
 *    action. A modal appeared, results populated, a chart rendered, a
 *    new page loaded with rich content. The bigger the visual delta
 *    between consecutive screenshots, the stronger the signal.
 *
 * 2. SEMANTIC IMPORTANCE — the action itself is significant regardless
 *    of how much the screen changed. Clicking "Deploy", "Purchase",
 *    "Delete", "Submit" — these are the *point* of the demo. The
 *    viewer needs to see what was clicked and where. Also: the first
 *    time the demo interacts with a new feature area, or the final
 *    step in a multi-step workflow (the payoff after setup).
 *
 * Either signal alone can justify a zoom. Both together strongly do.
 *
 * Centering depends on the signal type:
 *  - Visual change → center on the new content that appeared
 *  - Semantic click → center on the element being clicked
 *
 * LOW SIGNAL — skip:
 *  - Preparatory/mechanical actions: clicking into fields, dropdown
 *    opens, scrolling, typing characters, navigating between pages.
 *  - Repeated patterns: once the viewer has seen it, skip the rest.
 *  - No visible change AND no semantic importance.
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

  const totalSec = ((entries[entries.length - 1]?.t || 0) / 1000).toFixed(0);

  content.push({
    type: "text",
    text: `You are a video director reviewing a ${totalSec}-second product demo recording (1024x768). Your task: identify which moments deserve a camera zoom-in so the viewer doesn't miss them.

Each screenshot below shows the screen state AFTER an action was performed. You can see what action was taken and where.

Here are the moments:`,
  });

  for (const entry of sampled) {
    const timeSec = entry.t / 1000;
    const desc = `${entry.action || "action"}${entry.coords ? ` at (${entry.coords[0]}, ${entry.coords[1]})` : ""}`;

    // Find the closest screenshot
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
Now decide which moments deserve a zoom. A moment is zoom-worthy when the viewer would miss something important at full-screen scale. There are two independent reasons to zoom:

SIGNAL 1 — VISUAL CHANGE: The screen looks substantially different after the action.
- A new page, modal, panel, or overlay appeared
- Results/data/content populated an area that was previously empty
- A workflow completed and produced a visible outcome (form → success state, search → results, upload → preview)
- A key product feature became visible for the first time
→ Center the zoom on the NEW CONTENT that appeared, not on the trigger element.

SIGNAL 2 — SEMANTICALLY IMPORTANT ACTION: The action itself is significant, even if the visual change is subtle.
- A high-stakes click: "Deploy", "Purchase", "Delete", "Send", "Confirm", "Submit" — the moment the demo was building toward
- The first interaction with a new feature area of the product
- The final step of a multi-step workflow — the payoff after setup steps
- Read the button/link text in the screenshot to judge importance
→ Center the zoom on the element being clicked so the viewer sees what was activated.

Either signal alone can justify a zoom. Both together strongly do.

NOT ZOOM-WORTHY (neither signal present):
- Mechanical/preparatory actions: clicking into text fields, opening dropdowns, selecting options, scrolling, navigating
- Typing text character-by-character (zoom on the result after, if significant, not the typing)
- Hover effects, focus rings, checkbox toggles, minor UI state changes
- Repeated similar interactions — once the viewer has seen the pattern, skip the rest
- Actions where the screenshot looks the same as the previous one AND the action text is routine

Return a JSON array. Each entry:
- startSec: when to begin the zoom (seconds)
- endSec: when to end (2-4 seconds later)
- zoomLevel: 1.5 for most moments, 1.8 only if the target content is small. Never exceed 2.0
- cx: x center of zoom target (0-1024)
- cy: y center of zoom target (0-768)
- reason: what makes this moment zoom-worthy (visual change, semantic importance, or both)

If no moment warrants a zoom, return [].

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
        r.endSec > r.startSec &&
        r.zoomLevel <= 2.0,
    );
  } catch {
    console.log("  Director: failed to parse zoom regions from LLM response");
    return [];
  }
}
