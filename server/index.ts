import http from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join, extname, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig, saveConfig, getApiKey } from "./config.js";
import { runNativeComputerUseAgent } from "../src/agent/computer-use-native.js";
import { analyzeProject } from "../src/showcase/project-analyzer.js";
import { planShowcase } from "../src/showcase/showcase-planner.js";
import { AppLauncher } from "../src/showcase/app-launcher.js";
import { ActionLog } from "../src/recording/action-log.js";
import { autoEdit } from "../src/recording/auto-editor.js";
import pino from "pino";
import { runPreflight, printPreflight } from "./preflight.js";

const TRACES_DIR = resolve("traces");
// UI files: resolve relative to this file's location
// Works in both dev (server/index.ts → ../ui/dist) and built (dist/server/index.js → ../../ui/dist)
const __dirname_pkg = new URL(".", import.meta.url).pathname;
const UI_CANDIDATE_1 = resolve(join(__dirname_pkg, "..", "ui", "dist"));      // dev: server/ → ../ui/dist
const UI_CANDIDATE_2 = resolve(join(__dirname_pkg, "..", "..", "ui", "dist")); // built: dist/server/ → ../../ui/dist
const UI_DIR = existsSync(join(UI_CANDIDATE_1, "index.html")) ? UI_CANDIDATE_1 : UI_CANDIDATE_2;

// --- Active demos ---
interface ActiveDemo {
  id: string;
  status: "planning" | "recording" | "editing" | "done" | "error";
  task: string;
  url?: string;
  projectPath?: string;
  model: string;
  startedAt: number;
  log: string[];
  traceDir?: string;
  rawVideo?: string;
  editedVideo?: string;
  edl?: Array<{ startSec: number; endSec: number; type: string; label: string; speed?: number }>;
  error?: string;
}

const demos = new Map<string, ActiveDemo>();
const wsClients = new Set<WebSocket>();

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// --- MIME types ---
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// --- HTTP Server ---
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function sendFile(res: http.ServerResponse, filePath: string, req?: http.IncomingMessage): void {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  const stat = statSync(filePath);
  const fileSize = stat.size;

  // Support HTTP range requests for video seeking
  const range = req?.headers?.range;
  if (range && (ext === ".mp4" || ext === ".webm")) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": mime,
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": fileSize,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(filePath).pipe(res);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // --- API Routes ---

  // Preflight checks
  if (path === "/api/preflight" && method === "GET") {
    const checks = runPreflight();
    const config = loadConfig();
    const apiKeySet = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
    sendJson(res, {
      checks,
      apiKeySet,
      allOk: checks.every((c) => c.status === "ok") && apiKeySet,
    });
    return;
  }

  // Config
  if (path === "/api/config" && method === "GET") {
    const config = loadConfig();
    // Mask API key
    sendJson(res, {
      ...config,
      anthropicApiKey: config.anthropicApiKey ? "sk-...configured" : undefined,
    });
    return;
  }

  if (path === "/api/config" && method === "PUT") {
    const body = await parseBody(req);
    saveConfig(body);
    sendJson(res, { ok: true });
    return;
  }

  // List demos
  if (path === "/api/demos" && method === "GET") {
    const list: any[] = [];
    // From active demos
    for (const [id, demo] of demos) {
      list.push({
        id,
        status: demo.status,
        task: demo.task,
        startedAt: demo.startedAt,
        editedVideo: demo.editedVideo ? `/api/demo/${id}/video/edited` : undefined,
        rawVideo: demo.rawVideo ? `/api/demo/${id}/video/raw` : undefined,
      });
    }
    // From trace dirs
    if (existsSync(TRACES_DIR)) {
      for (const dir of readdirSync(TRACES_DIR).filter((d) => d.startsWith("agent_")).sort().reverse().slice(0, 20)) {
        if (demos.has(dir)) continue;
        const traceDir = join(TRACES_DIR, dir);
        const editedPath = join(traceDir, "edited.mp4");
        const rawPath = join(traceDir, "recording.mp4");
        const logPath = join(traceDir, "action-log.json");
        list.push({
          id: dir,
          status: "done",
          task: "",
          startedAt: statSync(traceDir).birthtimeMs,
          editedVideo: existsSync(editedPath) ? `/api/demo/${dir}/video/edited` : undefined,
          rawVideo: existsSync(rawPath) ? `/api/demo/${dir}/video/raw` : undefined,
          hasActionLog: existsSync(logPath),
          thumbnail: existsSync(join(traceDir, "thumbnail.jpg")) ? `/api/demo/${dir}/thumbnail` : undefined,
        });
      }
    }
    sendJson(res, list);
    return;
  }

  // Start a demo
  if (path === "/api/demo" && method === "POST") {
    const body = await parseBody(req);
    const { task, url: inputUrl, projectPath, model, instructions } = body;

    const apiKey = getApiKey();
    if (!apiKey) {
      sendJson(res, { error: "No API key configured. Go to Settings." }, 400);
      return;
    }

    const id = `agent_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_web`;
    const demo: ActiveDemo = {
      id,
      status: "recording",
      task: task || instructions || "Explore the website",
      url: inputUrl,
      projectPath,
      model: model || loadConfig().defaultModel,
      startedAt: Date.now(),
      log: [],
    };
    demos.set(id, demo);

    broadcast({ type: "demo_started", id });
    sendJson(res, { id });

    // Run in background
    runDemo(demo, apiKey, instructions).catch((err) => {
      demo.status = "error";
      demo.error = err.message;
      broadcast({ type: "demo_error", id, error: err.message });
    });
    return;
  }

  // Get demo status
  const demoMatch = path.match(/^\/api\/demo\/([^/]+)$/);
  if (demoMatch && method === "GET") {
    const id = demoMatch[1];
    const demo = demos.get(id);
    if (demo) {
      sendJson(res, demo);
    } else {
      // Check traces dir
      const traceDir = join(TRACES_DIR, id);
      if (existsSync(traceDir)) {
        const logPath = join(traceDir, "action-log.json");
        sendJson(res, {
          id,
          status: "done",
          traceDir,
          rawVideo: existsSync(join(traceDir, "recording.mp4")) ? `/api/demo/${id}/video/raw` : undefined,
          editedVideo: existsSync(join(traceDir, "edited.mp4")) ? `/api/demo/${id}/video/edited` : undefined,
          edl: existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf-8")) : undefined,
        });
      } else {
        sendJson(res, { error: "Not found" }, 404);
      }
    }
    return;
  }

  // Serve video files
  const videoMatch = path.match(/^\/api\/demo\/([^/]+)\/video\/(raw|edited)$/);
  if (videoMatch && method === "GET") {
    const [, id, type] = videoMatch;
    const filename = type === "edited" ? "edited.mp4" : "recording.mp4";
    // Check active demo first
    const demo = demos.get(id);
    if (demo?.traceDir) {
      sendFile(res, join(demo.traceDir, filename), req);
      return;
    }
    // Check traces dir
    sendFile(res, join(TRACES_DIR, id, filename), req);
    return;
  }

  // Save/load demo metadata (name, edl, zoom regions)
  const metaMatch = path.match(/^\/api\/demo\/([^/]+)\/metadata$/);
  if (metaMatch && method === "PUT") {
    const id = metaMatch[1];
    const body = await parseBody(req);
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const metaPath = join(traceDir, "metadata.json");
    let existing: Record<string, unknown> = {};
    if (existsSync(metaPath)) {
      try { existing = JSON.parse(readFileSync(metaPath, "utf-8")); } catch {}
    }
    const merged = { ...existing, ...body };
    writeFileSync(metaPath, JSON.stringify(merged, null, 2));
    // Also update in-memory demo
    if (demo && body.name) demo.task = body.name;
    sendJson(res, { ok: true });
    return;
  }
  if (metaMatch && method === "GET") {
    const id = metaMatch[1];
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const metaPath = join(traceDir, "metadata.json");
    if (existsSync(metaPath)) {
      sendJson(res, JSON.parse(readFileSync(metaPath, "utf-8")));
    } else {
      sendJson(res, {});
    }
    return;
  }

  // Delete a demo
  const deleteMatch = path.match(/^\/api\/demo\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const id = deleteMatch[1];
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    // Remove from memory
    demos.delete(id);
    // Remove from disk
    try {
      const { execSync: ex } = await import("node:child_process");
      if (existsSync(traceDir)) {
        ex(`rm -rf "${traceDir}"`);
      }
    } catch {}
    sendJson(res, { ok: true });
    return;
  }

  // Serve thumbnail
  const thumbMatch = path.match(/^\/api\/demo\/([^/]+)\/thumbnail$/);
  if (thumbMatch && method === "GET") {
    const id = thumbMatch[1];
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const thumbPath = join(traceDir, "thumbnail.jpg");
    if (existsSync(thumbPath)) {
      sendFile(res, thumbPath, req);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // Get director zoom regions
  const zoomMatch = path.match(/^\/api\/demo\/([^/]+)\/zoom-regions$/);
  if (zoomMatch && method === "GET") {
    const id = zoomMatch[1];
    const demo = demos.get(id);
    const zoomPath = join(demo?.traceDir || join(TRACES_DIR, id), "zoom-regions.json");
    if (existsSync(zoomPath)) {
      sendJson(res, JSON.parse(readFileSync(zoomPath, "utf-8")));
    } else {
      sendJson(res, [], 200); // Empty array = no director regions
    }
    return;
  }

  // Get/update EDL
  const edlMatch = path.match(/^\/api\/demo\/([^/]+)\/edl$/);
  if (edlMatch && method === "GET") {
    const id = edlMatch[1];
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const logPath = join(traceDir, "action-log.json");
    if (existsSync(logPath)) {
      sendJson(res, JSON.parse(readFileSync(logPath, "utf-8")));
    } else {
      sendJson(res, { error: "No action log" }, 404);
    }
    return;
  }

  // Export in different formats
  const exportMatch = path.match(/^\/api\/demo\/([^/]+)\/export$/);
  if (exportMatch && method === "POST") {
    const id = exportMatch[1];
    const body = await parseBody(req);
    const format = body.format || "mp4";
    const source = body.source || "edited";
    const traceDir = join(TRACES_DIR, id);

    // Find source video
    const demo = demos.get(id);
    const sourceFile = source === "edited"
      ? join(demo?.traceDir || traceDir, "edited.mp4")
      : join(demo?.traceDir || traceDir, "recording.mp4");

    if (!existsSync(sourceFile)) {
      sendJson(res, { error: "Source video not found" }, 404);
      return;
    }

    const outputDir = demo?.traceDir || traceDir;
    let outputFile: string;
    let ffmpegArgs: string;

    switch (format) {
      case "webm":
        outputFile = join(outputDir, "export.webm");
        ffmpegArgs = `-c:v libvpx-vp9 -crf 30 -b:v 0 -an`;
        break;
      case "mp4-social":
        outputFile = join(outputDir, "export-social.mp4");
        ffmpegArgs = `-vf "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black" -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -an`;
        break;
      case "mp4-story":
        outputFile = join(outputDir, "export-story.mp4");
        ffmpegArgs = `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -an`;
        break;
      case "gif":
        outputFile = join(outputDir, "export.gif");
        ffmpegArgs = `-vf "fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" -loop 0`;
        break;
      default:
        outputFile = join(outputDir, "export.mp4");
        ffmpegArgs = `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an`;
    }

    try {
      const { execSync: execS } = await import("node:child_process");
      execS(`ffmpeg -y -i "${sourceFile}" ${ffmpegArgs} "${outputFile}" 2>/dev/null`);
      // Serve via API
      const ext = format === "gif" ? "gif" : format.includes("webm") ? "webm" : "mp4";
      sendJson(res, { ok: true, downloadUrl: `/api/demo/${id}/export/${ext}` });
    } catch (err: any) {
      sendJson(res, { error: `Conversion failed: ${err.message}` }, 500);
    }
    return;
  }

  // Serve exported files
  const exportFileMatch = path.match(/^\/api\/demo\/([^/]+)\/export\/(mp4|webm|gif)$/);
  if (exportFileMatch && method === "GET") {
    const [, id, ext] = exportFileMatch;
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const candidates = [
      join(traceDir, `export.${ext}`),
      join(traceDir, `export-social.mp4`),
      join(traceDir, `export-story.mp4`),
    ];
    const found = candidates.find((f) => existsSync(f));
    if (found) {
      sendFile(res, found);
    } else {
      res.writeHead(404);
      res.end("Export not found");
    }
    return;
  }

  // Re-run auto-edit
  const reEditMatch = path.match(/^\/api\/demo\/([^/]+)\/re-edit$/);
  if (reEditMatch && method === "POST") {
    const id = reEditMatch[1];
    const demo = demos.get(id);
    const traceDir = demo?.traceDir || join(TRACES_DIR, id);
    const rawVideo = join(traceDir, "recording.mp4");
    const actionLogPath = join(traceDir, "action-log.json");
    const editedPath = join(traceDir, "edited.mp4");

    if (!existsSync(rawVideo) || !existsSync(actionLogPath)) {
      sendJson(res, { error: "Missing files" }, 404);
      return;
    }

    try {
      await autoEdit({
        inputVideo: rawVideo,
        actionLog: actionLogPath,
        outputVideo: editedPath,
      });
      sendJson(res, { ok: true, video: `/api/demo/${id}/video/edited` });
    } catch (err: any) {
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  // --- Static Files (UI) ---
  let filePath = path === "/" ? "/index.html" : path;
  const fullPath = join(UI_DIR, filePath);
  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
    sendFile(res, fullPath);
    return;
  }

  // SPA fallback
  const indexPath = join(UI_DIR, "index.html");
  if (existsSync(indexPath)) {
    sendFile(res, indexPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found — run `npm run build:ui` first");
}

// --- Demo Runner ---
async function runDemo(demo: ActiveDemo, apiKey: string, instructions?: string): Promise<void> {
  const logger = pino({ level: "info" });

  let startUrl = demo.url;
  let appLauncher: AppLauncher | null = null;

  // If projectPath, analyze, plan, and launch
  let task = demo.task;
  if (demo.projectPath && !startUrl) {
    demo.status = "planning";
    broadcast({ type: "demo_status", id: demo.id, status: "planning" });

    const projectInfo = await analyzeProject(demo.projectPath);
    demo.log.push(`Analyzed: ${projectInfo.name} (${projectInfo.framework})`);
    broadcast({ type: "demo_log", id: demo.id, message: `Analyzed: ${projectInfo.name} (${projectInfo.framework})` });

    // Launch dev server
    appLauncher = new AppLauncher(logger);
    await appLauncher.start(demo.projectPath, projectInfo.startCommand, projectInfo.startUrl);
    startUrl = appLauncher.getActualUrl() || projectInfo.startUrl;
    demo.log.push(`Server started at ${startUrl}`);
    broadcast({ type: "demo_log", id: demo.id, message: `Server started at ${startUrl}` });

    // Use showcase planner to generate a smart task from the code
    if (!instructions) {
      try {
        process.env.ANTHROPIC_API_KEY = apiKey;
        const scenarios = await planShowcase(projectInfo, demo.model, logger, 1, undefined);
        if (scenarios.length > 0) {
          task = scenarios[0].description;
          demo.log.push(`Planned: ${scenarios[0].title}`);
          broadcast({ type: "demo_log", id: demo.id, message: `Demo plan: ${scenarios[0].title}` });
        }
      } catch {
        // Fall through to default task
      }
    }
  }

  // If no instructions and just a URL, use a smart default prompt
  if (!instructions && !demo.projectPath) {
    task = `You are creating a product demo video of this website. Take a screenshot first, then plan a compelling walkthrough that shows off the key features. Navigate through the main pages, interact with buttons and forms, scroll through content sections. Make it look like a natural product tour. When done, summarize what you demonstrated.`;
  } else if (instructions) {
    task = `${task}\n\nAdditional context: ${instructions}`;
  }

  demo.status = "recording";
  broadcast({ type: "demo_status", id: demo.id, status: "recording" });

  // Intercept console.log to capture agent output
  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.map(String).join(" ");
    demo.log.push(msg);
    broadcast({ type: "demo_log", id: demo.id, message: msg });
    origLog(...args);
  };

  process.env.ANTHROPIC_API_KEY = apiKey;

  try {
    const result = await runNativeComputerUseAgent({
      task,
      startUrl: startUrl || "",
      model: demo.model,
      maxIterations: loadConfig().maxIterations,
      totalTimeoutMs: loadConfig().timeout,
      traceDir: TRACES_DIR,
    });

    demo.traceDir = result.traceDir;
    demo.rawVideo = join(result.traceDir, "recording.mp4");
    demo.editedVideo = existsSync(join(result.traceDir, "edited.mp4"))
      ? join(result.traceDir, "edited.mp4")
      : undefined;
    demo.status = "done";

    broadcast({
      type: "demo_done",
      id: demo.id,
      rawVideo: `/api/demo/${demo.id}/video/raw`,
      editedVideo: demo.editedVideo ? `/api/demo/${demo.id}/video/edited` : undefined,
    });
  } catch (err: any) {
    demo.status = "error";
    demo.error = err.message;
    broadcast({ type: "demo_error", id: demo.id, error: err.message });
  } finally {
    console.log = origLog;
    if (appLauncher) await appLauncher.stop();
  }
}

// --- Start Server ---
export function startServer(port = 3456): void {
  // Run preflight checks on startup
  console.log("  Preflight checks:");
  const checks = runPreflight();
  printPreflight(checks);
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Server error:", err);
      res.writeHead(500);
      res.end("Internal error");
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
  });

  server.listen(port, () => {
    console.log(`\ndemoo running at http://localhost:${port}\n`);
  });
}
