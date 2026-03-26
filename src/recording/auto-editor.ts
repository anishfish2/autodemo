import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { ActionLogEntry } from "./action-log.js";

interface EditSegment {
  startSec: number;
  endSec: number;
  type: "keep" | "cut";
  label: string;
}

interface CursorKeyframe {
  frameSec: number; // time in OUTPUT video
  x: number;
  y: number;
}

/**
 * Quadratic bezier point at parameter t.
 * Adds a perpendicular arc offset scaled by distance.
 */
function bezierArc(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  t: number,
): { x: number; y: number } {
  const dist = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
  // Control point: midpoint + perpendicular offset
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  // Perpendicular direction (rotated 90 degrees)
  const dx = bx - ax;
  const dy = by - ay;
  const perpX = -dy;
  const perpY = dx;
  const len = Math.sqrt(perpX ** 2 + perpY ** 2) || 1;
  // Arc offset: 12% of distance, always curves one direction
  const offset = dist * 0.12;
  const cx = mx + (perpX / len) * offset;
  const cy = my + (perpY / len) * offset;

  // Quadratic bezier: (1-t)²A + 2(1-t)tC + t²B
  const u = 1 - t;
  return {
    x: Math.round(u * u * ax + 2 * u * t * cx + t * t * bx),
    y: Math.round(u * u * ay + 2 * u * t * cy + t * t * by),
  };
}

/** Ease-out cubic: fast start, slow arrival */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Build an edit decision list from action timing data.
 *
 * Strategy:
 * - Keep 0.8s after each action (see the result)
 * - Keep 0.3s before each action (approach)
 * - Cut everything in between (thinking time, screenshot overhead)
 * - Insert cursor arc animation to bridge cuts
 */
function buildEDL(
  entries: ActionLogEntry[],
  totalDurationSec: number,
): EditSegment[] {
  // Find all action timestamps
  const actions: { startSec: number; endSec: number; coords?: [number, number] }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "action" && e.action !== "screenshot" && e.action !== "zoom") {
      const startSec = e.t / 1000;
      // Find corresponding action_done
      const done = entries.slice(i + 1).find((x) => x.type === "action_done");
      const endSec = done ? done.t / 1000 : startSec + 0.5;
      actions.push({ startSec, endSec, coords: e.coords });
    }
  }

  if (actions.length === 0) {
    return [{ startSec: 0, endSec: totalDurationSec, type: "keep", label: "no actions" }];
  }

  const segments: EditSegment[] = [];
  const HOLD_AFTER = 0.8; // seconds to keep after action completes
  const APPROACH_BEFORE = 0.8; // seconds to keep before action starts (captures cursor arc animation)

  // Before first action
  if (actions[0].startSec > 1) {
    // Keep first 1 second (page appears), cut the rest
    segments.push({ startSec: 0, endSec: 1, type: "keep", label: "intro" });
    if (actions[0].startSec - APPROACH_BEFORE > 1) {
      segments.push({
        startSec: 1,
        endSec: actions[0].startSec - APPROACH_BEFORE,
        type: "cut",
        label: "initial thinking",
      });
    }
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const nextAction = actions[i + 1];

    // Approach (before action)
    const approachStart = Math.max(
      segments.length > 0 ? segments[segments.length - 1].endSec : 0,
      action.startSec - APPROACH_BEFORE,
    );
    if (approachStart < action.startSec) {
      segments.push({
        startSec: approachStart,
        endSec: action.startSec,
        type: "keep",
        label: `approach ${action.coords ? `(${action.coords[0]},${action.coords[1]})` : ""}`,
      });
    }

    // The action itself
    segments.push({
      startSec: action.startSec,
      endSec: action.endSec,
      type: "keep",
      label: "action",
    });

    // Hold after action (see result)
    const holdEnd = Math.min(action.endSec + HOLD_AFTER, totalDurationSec);
    segments.push({
      startSec: action.endSec,
      endSec: holdEnd,
      type: "keep",
      label: "hold (view result)",
    });

    // Gap until next action — CUT (dead time)
    if (nextAction) {
      const gapStart = holdEnd;
      const gapEnd = nextAction.startSec - APPROACH_BEFORE;
      if (gapEnd > gapStart + 0.1) {
        segments.push({
          startSec: gapStart,
          endSec: gapEnd,
          type: "cut",
          label: "thinking",
        });
      }
    }
  }

  // After last action — keep 2 seconds then cut
  const lastEnd = segments[segments.length - 1]?.endSec ?? 0;
  if (lastEnd < totalDurationSec) {
    const keepEnd = Math.min(lastEnd + 2, totalDurationSec);
    segments.push({ startSec: lastEnd, endSec: keepEnd, type: "keep", label: "outro" });
    if (keepEnd < totalDurationSec) {
      segments.push({ startSec: keepEnd, endSec: totalDurationSec, type: "cut", label: "trailing" });
    }
  }

  return segments;
}

/**
 * Generate cursor keyframes for the edited video.
 * Smooth bezier arcs between click positions, ease-out timing.
 */
function buildCursorKeyframes(
  entries: ActionLogEntry[],
  edl: EditSegment[],
  fps: number,
): CursorKeyframe[] {
  // Get click positions with their timestamps
  const clicks: { sec: number; x: number; y: number }[] = [];
  for (const e of entries) {
    if (e.type === "action" && e.coords && e.action === "left_click") {
      clicks.push({ sec: e.t / 1000, x: e.coords[0], y: e.coords[1] });
    }
  }

  if (clicks.length === 0) return [];

  // Map input timestamps to output timestamps (accounting for cuts)
  function inputToOutputTime(inputSec: number): number {
    let outputSec = 0;
    for (const seg of edl) {
      if (seg.type === "cut") continue;
      if (inputSec <= seg.startSec) break;
      if (inputSec >= seg.endSec) {
        outputSec += seg.endSec - seg.startSec;
      } else {
        outputSec += inputSec - seg.startSec;
        break;
      }
    }
    return outputSec;
  }

  const keyframes: CursorKeyframe[] = [];
  const ARC_DURATION = 0.5; // seconds for cursor arc in output time

  for (let i = 0; i < clicks.length; i++) {
    const click = clicks[i];
    const outputTime = inputToOutputTime(click.sec);

    if (i > 0) {
      const prev = clicks[i - 1];
      const prevOutputTime = inputToOutputTime(prev.sec);

      // Generate arc from previous click to this click
      // The arc plays in the output timeline between prevOutputTime+hold and outputTime
      const arcStart = prevOutputTime + 0.8; // after hold
      const arcEnd = outputTime - 0.1; // just before click
      const arcDur = arcEnd - arcStart;

      if (arcDur > 0.1) {
        const steps = Math.round(arcDur * fps);
        for (let s = 0; s <= steps; s++) {
          const t = easeOutCubic(s / Math.max(steps, 1));
          const pos = bezierArc(prev.x, prev.y, click.x, click.y, t);
          keyframes.push({
            frameSec: arcStart + (arcDur * s) / Math.max(steps, 1),
            x: pos.x,
            y: pos.y,
          });
        }
      }
    }

    // Hold at click position
    keyframes.push({ frameSec: outputTime, x: click.x, y: click.y });
  }

  return keyframes;
}

/**
 * Auto-edit a recording: cut dead time, insert cursor arcs.
 */
export async function autoEdit(options: {
  inputVideo: string;
  actionLog: string;
  outputVideo: string;
}): Promise<void> {
  const entries: ActionLogEntry[] = JSON.parse(
    readFileSync(options.actionLog, "utf-8"),
  );

  // Get video duration and fps
  const probeOutput = execSync(
    `ffprobe -v error -show_entries format=duration -show_entries stream=r_frame_rate -of json "${options.inputVideo}"`,
    { encoding: "utf-8" },
  );
  const probed = JSON.parse(probeOutput);
  const totalDuration = parseFloat(probed.format.duration);
  const fps = 30; // assume 30fps

  // Build EDL
  const edl = buildEDL(entries, totalDuration);

  // Print summary
  let keptTime = 0;
  let cutTime = 0;
  console.log("\n  Edit Decision List:");
  for (const seg of edl) {
    const dur = seg.endSec - seg.startSec;
    if (seg.type === "keep") {
      keptTime += dur;
      console.log(
        `    KEEP  ${seg.startSec.toFixed(1)}s-${seg.endSec.toFixed(1)}s (${dur.toFixed(1)}s) — ${seg.label}`,
      );
    } else {
      cutTime += dur;
      console.log(
        `    CUT   ${seg.startSec.toFixed(1)}s-${seg.endSec.toFixed(1)}s (${dur.toFixed(1)}s) — ${seg.label}`,
      );
    }
  }
  console.log(
    `  Total: ${totalDuration.toFixed(1)}s → ~${keptTime.toFixed(1)}s (cut ${cutTime.toFixed(1)}s)\n`,
  );

  // Extract kept segments
  const workDir = dirname(options.outputVideo);
  const segmentFiles: string[] = [];
  let segIdx = 0;

  for (const seg of edl) {
    if (seg.type === "cut") continue;
    const dur = seg.endSec - seg.startSec;
    if (dur < 0.05) continue;

    const segPath = join(workDir, `_seg_${String(segIdx++).padStart(3, "0")}.mp4`);
    segmentFiles.push(segPath);

    execSync(
      `ffmpeg -y -ss ${seg.startSec.toFixed(3)} -to ${seg.endSec.toFixed(3)} -i "${options.inputVideo}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an "${segPath}" 2>/dev/null`,
    );
  }

  if (segmentFiles.length === 0) {
    console.log("  No segments to concatenate.");
    return;
  }

  // Write concat list with absolute paths
  const concatList = join(workDir, "_concat.txt");
  writeFileSync(
    concatList,
    segmentFiles.map((f) => `file '${resolve(f)}'`).join("\n"),
  );

  // Concatenate
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an "${options.outputVideo}" 2>/dev/null`,
  );

  // Cleanup
  if (existsSync(options.outputVideo)) {
    for (const f of segmentFiles) {
      try { execSync(`rm "${f}"`); } catch {}
    }
    try { execSync(`rm "${concatList}"`); } catch {}
    console.log(`  Edited video saved: ${options.outputVideo}`);
  }
}
