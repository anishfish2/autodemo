import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Logger } from "pino";
import type { RecordingEvent, ProcessingOptions } from "./recording-types.js";

const execFileAsync = promisify(execFile);

interface ZoomKeyframe {
  timeMs: number;
  x: number;
  y: number;
  zoom: number; // 1.0 = no zoom, 2.0 = 2x zoom
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Build zoom keyframes ONLY from explicit director events (zoom_to / zoom_out).
 * No auto-zoom — if the LLM didn't ask for zoom, we show full screen.
 */
function buildZoomKeyframes(
  events: RecordingEvent[],
  defaultZoomLevel: number,
): ZoomKeyframe[] {
  const directorZooms = events.filter(
    (e) => e.type === "zoom_to" || e.type === "zoom_out",
  );

  // No zoom if level is 1 or no director events
  if (directorZooms.length === 0 || defaultZoomLevel <= 1) return [];

  return directorZooms.map((e) => ({
    timeMs: e.timestamp,
    x: e.x ?? 960,
    y: e.y ?? 540,
    zoom: e.type === "zoom_out" ? 1.0 : (e.zoom_level ?? defaultZoomLevel),
  }));
}

/**
 * Build a setpts expression for speed changes.
 * Speed events define segments: at timestamp T, set speed to S.
 * setpts adjusts presentation timestamps so faster segments have smaller gaps.
 *
 * The approach: compute cumulative output time at each speed boundary,
 * then build a piecewise expression that maps input time to output time.
 */
function buildSpeedFilter(
  events: RecordingEvent[],
  fps: number,
): string | null {
  const speedEvents = events.filter((e) => e.type === "set_speed" && e.speed != null);
  if (speedEvents.length === 0) return null;

  // Sort by timestamp
  const sorted = [...speedEvents].sort((a, b) => a.timestamp - b.timestamp);

  // Build segments: [startSec, endSec, speed]
  // First segment: from 0 to first speed event at speed 1
  // Last segment: from last event to end at that speed
  interface SpeedSegment {
    startSec: number;
    speed: number;
  }
  const segments: SpeedSegment[] = [{ startSec: 0, speed: 1 }];
  for (const evt of sorted) {
    segments.push({ startSec: evt.timestamp / 1000, speed: evt.speed ?? 1 });
  }

  // Build a piecewise setpts expression
  // For each segment, the output PTS = accumulated_output_time + (t - segment_start) / speed
  // We compute this as a nested if() expression over input time t
  //
  // setpts works with PTS in timebase units. Using 'T' (time in seconds) is cleaner.
  // Formula: new_T = offset + (T - seg_start) / speed
  // where offset accumulates the output duration of all prior segments.

  let outputOffset = 0; // accumulated output seconds up to current segment
  const parts: Array<{ startSec: number; speed: number; outputOffset: number }> = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    parts.push({ startSec: seg.startSec, speed: seg.speed, outputOffset });

    // Compute this segment's duration in input time
    if (i < segments.length - 1) {
      const inputDuration = segments[i + 1].startSec - seg.startSec;
      const outputDuration = inputDuration / seg.speed;
      outputOffset += outputDuration;
    }
  }

  // Build nested if expression for setpts
  // setpts expects PTS (in timebase), so we work with N (frame number) and TB
  // Simplest: setpts='...*PTS/TB*TB' or just use N and frame-based math
  //
  // Actually, the cleanest approach for setpts:
  // We express the new timestamp as a function of the old frame number N.
  // new_time(N) = output_offset_for_segment + (N/fps - seg_start) / speed
  // new_PTS = new_time * TB * fps  ... but this gets complex.
  //
  // Simpler: use setpts with the 'T' variable (input time in seconds)
  // setpts='(expr)*TB' where expr gives output time in seconds
  //
  // Even simpler: setpts just needs an expression that evaluates to the
  // new PTS value. PTS = time * timebase. Since we can use T (input seconds):
  // setpts = '<output_seconds_expr> / TB'
  //
  // Actually the simplest correct form:
  // setpts='<expr>*PTS/T' won't work for T=0.
  //
  // Most reliable: express as frame-based. For frame N at fps:
  //   input_time = N / fps
  //   output_time = piecewise function of input_time
  //   output_PTS = output_time / TB

  let expr = "";
  for (let i = parts.length - 1; i >= 1; i--) {
    const p = parts[i];
    // For this segment: output_time = offset + (T - start) / speed
    const piece = `${p.outputOffset.toFixed(6)}+(T-${p.startSec.toFixed(6)})/${p.speed.toFixed(4)}`;
    expr = `if(gte(T\\,${p.startSec.toFixed(6)})\\,${piece}\\,${expr || "T"})`;
  }
  // First segment (speed from time 0)
  if (parts.length > 0 && parts[0].startSec === 0 && parts[0].speed !== 1) {
    expr = expr || `T/${parts[0].speed.toFixed(4)}`;
  }

  if (!expr || expr === "T") return null; // No effective speed change

  return `setpts='(${expr})/TB'`;
}

/**
 * Build cursor overlay filter from cursor position events.
 * Samples cursor positions and draws a small pointer circle at each.
 */
function buildCursorOverlay(events: RecordingEvent[], fps: number): string {
  const cursorEvents = events.filter(
    (e) => e.type === "cursor" && e.x != null && e.y != null,
  );
  if (cursorEvents.length === 0) return "";

  // Sample every ~100ms worth of events to keep filter manageable
  // Cursor events come at ~30ms intervals (20 steps per animation)
  const sampled: RecordingEvent[] = [];
  let lastTs = -100;
  for (const evt of cursorEvents) {
    if (evt.timestamp - lastTs >= 66) {
      // ~15fps cursor updates
      sampled.push(evt);
      lastTs = evt.timestamp;
    }
  }

  // Build timed drawbox filters — each cursor position visible until the next
  let overlay = "";
  for (let i = 0; i < sampled.length; i++) {
    const evt = sampled[i];
    const startSec = evt.timestamp / 1000;
    const endSec =
      i < sampled.length - 1
        ? sampled[i + 1].timestamp / 1000
        : startSec + 0.5;
    const cx = evt.x! - 6;
    const cy = evt.y! - 6;

    // Draw a small white circle (12x12 box as approximation) with border
    overlay += `,drawbox=x=${cx - 1}:y=${cy - 1}:w=14:h=14:color=black@0.5:t=fill:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;
    overlay += `,drawbox=x=${cx}:y=${cy}:w=12:h=12:color=white@0.9:t=fill:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;
  }

  return overlay;
}

/**
 * Generate ffmpeg filter_complex string for zoompan + click overlays + speed.
 */
function buildFilterGraph(
  events: RecordingEvent[],
  keyframes: ZoomKeyframe[],
  options: ProcessingOptions,
  outputRes?: { w: number; h: number },
): string {
  const { resolution, fps, zoomLevel } = options;
  const W = resolution.w;
  const H = resolution.h;
  const outW = outputRes?.w ?? W;
  const outH = outputRes?.h ?? H;

  // Build speed filter
  const speedFilter = buildSpeedFilter(events, fps);

  // Build cursor overlay
  const cursorOverlay = buildCursorOverlay(events, fps);

  if (keyframes.length === 0) {
    let filter = `scale=${outW}:${outH}`;
    if (cursorOverlay) filter += cursorOverlay;
    if (speedFilter) filter += `,${speedFilter}`;
    return filter;
  }

  // Build zoompan with keyframed positions
  // zoompan works frame-by-frame, so we need to generate expressions
  // that interpolate between our keyframes

  // Convert keyframes to frame numbers
  const frameKeyframes = keyframes.map((kf) => ({
    frame: Math.round((kf.timeMs / 1000) * fps),
    x: kf.x,
    y: kf.y,
    zoom: kf.zoom,
  }));

  // Generate a zoompan expression that interpolates between keyframes
  // We use a simplified approach: generate crop coordinates per-segment
  // and use the sendcmd/zmq approach or a complex expression

  // Simpler approach: use crop filter with per-frame coordinates
  // We'll generate a script of crop positions and use ffmpeg's zoompan

  // For now, use a constant zoom centered on the average cursor position
  // of active regions, with smooth panning
  const avgX =
    frameKeyframes.reduce((s, k) => s + k.x, 0) / frameKeyframes.length;
  const avgY =
    frameKeyframes.reduce((s, k) => s + k.y, 0) / frameKeyframes.length;

  // Crop dimensions at zoom level
  const cropW = Math.round(W / zoomLevel);
  const cropH = Math.round(H / zoomLevel);

  // Build piecewise linear expressions for x and y based on keyframes
  let xExpr = String(Math.round(avgX - cropW / 2));
  let yExpr = String(Math.round(avgY - cropH / 2));

  if (frameKeyframes.length >= 2) {
    // Build conditional expression: if(lt(n,f1), lerp1, if(lt(n,f2), lerp2, ...))
    xExpr = buildPiecewiseExpr(frameKeyframes, "x", cropW, W, fps);
    yExpr = buildPiecewiseExpr(frameKeyframes, "y", cropH, H, fps);
  }

  // Click overlays — draw circles at click positions
  const clickEvents = events.filter((e) => e.type === "click" && e.x != null);
  let overlayFilters = "";
  for (const click of clickEvents) {
    const startSec = click.timestamp / 1000;
    const endSec = startSec + 0.3;
    const cx = Math.round(click.x! - 15);
    const cy = Math.round(click.y! - 15);
    overlayFilters += `,drawbox=x=${cx}:y=${cy}:w=30:h=30:color=red@0.4:t=3:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;
  }

  // Highlight overlays from director events
  const highlights = events.filter((e) => e.type === "highlight" && e.x != null);
  for (const hl of highlights) {
    const startSec = hl.timestamp / 1000;
    const dur = (hl.duration_ms ?? 2000) / 1000;
    const endSec = startSec + dur;
    const color = (hl.color ?? "red").replace("#", "0x");
    overlayFilters += `,drawbox=x=${hl.x}:y=${hl.y}:w=${hl.width ?? 100}:h=${hl.height ?? 50}:color=${color}@0.5:t=4:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;
  }

  // Callout text overlays from director events
  const callouts = events.filter((e) => e.type === "callout" && e.text);
  for (const co of callouts) {
    const startSec = co.timestamp / 1000;
    const dur = (co.duration_ms ?? 3000) / 1000;
    const endSec = startSec + dur;
    const escapedText = (co.text ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\\\\\\''")
      .replace(/:/g, "\\:")
      .replace(/;/g, "\\;");
    overlayFilters += `,drawtext=text='${escapedText}':x=${co.x ?? 100}:y=${co.y ?? 100}:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;
  }

  let filter = `crop=${cropW}:${cropH}:${xExpr}:${yExpr},scale=${outW}:${outH}${cursorOverlay}${overlayFilters}`;
  if (speedFilter) filter += `,${speedFilter}`;
  return filter;
}

function buildPiecewiseExpr(
  keyframes: Array<{ frame: number; x: number; y: number; zoom: number }>,
  axis: "x" | "y",
  cropDim: number,
  maxDim: number,
  fps: number,
): string {
  // Generate a piecewise linear expression that ffmpeg can evaluate per-frame
  // Clamp values to valid range
  const clamp = (v: number) =>
    Math.max(0, Math.min(v, maxDim - cropDim));

  if (keyframes.length === 0) return "0";
  if (keyframes.length === 1) {
    const val = axis === "x" ? keyframes[0].x : keyframes[0].y;
    return String(clamp(Math.round(val - cropDim / 2)));
  }

  // Build nested if expressions for each segment
  let expr = "";
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const av = clamp(
      Math.round((axis === "x" ? a.x : a.y) - cropDim / 2),
    );
    const bv = clamp(
      Math.round((axis === "x" ? b.x : b.y) - cropDim / 2),
    );
    const frameDiff = b.frame - a.frame || 1;
    // Linear interpolation between a and b
    const lerp = `${av}+(${bv}-${av})*(n-${a.frame})/${frameDiff}`;
    expr += `if(lt(n\\,${b.frame})\\,${lerp}\\,`;
  }

  // Final segment — hold last value
  const last = keyframes[keyframes.length - 1];
  const lastVal = clamp(
    Math.round((axis === "x" ? last.x : last.y) - cropDim / 2),
  );
  expr += String(lastVal);
  // Close all the if() parens
  expr += ")".repeat(keyframes.length - 1);

  return expr;
}

async function probeVideoResolution(
  videoPath: string,
): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  return {
    w: stream?.width ?? 1920,
    h: stream?.height ?? 1080,
  };
}

export class VideoProcessor {
  constructor(private logger: Logger) {}

  async process(options: ProcessingOptions): Promise<string> {
    this.logger.info(
      { input: options.inputVideo, output: options.outputVideo },
      "Starting video post-processing",
    );

    // Detect actual source video resolution (may be Retina 2x)
    const sourceRes = await probeVideoResolution(options.inputVideo);
    const scaleX = sourceRes.w / options.resolution.w;
    const scaleY = sourceRes.h / options.resolution.h;
    this.logger.info(
      { source: sourceRes, target: options.resolution, scaleX, scaleY },
      "Detected source resolution",
    );

    // Use source resolution for processing, output at target resolution
    const processOpts = {
      ...options,
      // Use source dimensions for crop calculations
      resolution: sourceRes,
    };

    // Read events log
    const events: RecordingEvent[] = JSON.parse(
      readFileSync(options.eventsLog, "utf-8"),
    );

    // Scale event coordinates to match actual video pixels
    // Events are logged in logical (screen) coordinates, but video is in physical (Retina) pixels
    if (scaleX > 1.1 || scaleY > 1.1) {
      for (const event of events) {
        if (event.x != null) event.x = Math.round(event.x * scaleX);
        if (event.y != null) event.y = Math.round(event.y * scaleY);
        if (event.width != null) event.width = Math.round(event.width * scaleX);
        if (event.height != null) event.height = Math.round(event.height * scaleY);
      }
      this.logger.info(
        { scaleX, scaleY },
        "Scaled event coordinates for Retina display",
      );
    }

    // Build zoom keyframes from cursor events
    const keyframes = buildZoomKeyframes(events, processOpts.zoomLevel);
    this.logger.info(
      { keyframes: keyframes.length, events: events.length },
      "Generated zoom keyframes",
    );

    // Build ffmpeg filter graph using source resolution for crop,
    // then scale to target output resolution
    const filterGraph = buildFilterGraph(events, keyframes, processOpts, options.resolution);
    this.logger.debug({ filter: filterGraph }, "FFmpeg filter graph");

    // Write filter graph to file for debugging
    const filterScriptPath = join(
      dirname(options.outputVideo),
      "filter-script.txt",
    );
    writeFileSync(filterScriptPath, filterGraph);

    this.logger.info("Running FFmpeg post-processing...");

    // Use -filter_complex_script which reads from file and handles
    // expression commas correctly (no shell escaping needed)
    // In filter_complex_script, semicolons separate filterchain links,
    // commas separate filters within a chain, and expression commas
    // inside functions like if(lt(n,X),Y,Z) are parsed correctly
    // because FFmpeg's expression parser handles them before the
    // filter graph parser.
    //
    // However, -filter_complex_script expects a filter graph with
    // stream labels. For simple single-input single-output, we use
    // -filter_script:v which works the same way.
    writeFileSync(filterScriptPath, filterGraph);

    const args = [
      "-y",
      "-i",
      options.inputVideo,
      "-filter_script:v",
      filterScriptPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      options.outputVideo,
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 || existsSync(options.outputVideo)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });
      proc.on("error", reject);
    });

    this.logger.info(
      { output: options.outputVideo },
      "Video post-processing complete",
    );

    return options.outputVideo;
  }
}
