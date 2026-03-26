import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { ProjectInfo } from "./showcase-types.js";

interface FrameworkInfo {
  name: string;
  defaultPort: number;
  devScript: string;
}

const FRAMEWORKS: Record<string, FrameworkInfo> = {
  next: { name: "nextjs", defaultPort: 3000, devScript: "dev" },
  nuxt: { name: "nuxt", defaultPort: 3000, devScript: "dev" },
  "@sveltejs/kit": { name: "sveltekit", defaultPort: 5173, devScript: "dev" },
  svelte: { name: "svelte", defaultPort: 5173, devScript: "dev" },
  astro: { name: "astro", defaultPort: 4321, devScript: "dev" },
  vite: { name: "vite", defaultPort: 5173, devScript: "dev" },
  vue: { name: "vue", defaultPort: 5173, devScript: "dev" },
  "react-scripts": { name: "cra", defaultPort: 3000, devScript: "start" },
};

// Route discovery patterns by framework
const ROUTE_PATTERNS: Record<string, string[]> = {
  nextjs: ["app/**/page.tsx", "app/**/page.jsx", "app/**/page.ts", "app/**/page.js", "pages/**/*.tsx", "pages/**/*.jsx"],
  nuxt: ["pages/**/*.vue"],
  sveltekit: ["src/routes/**/+page.svelte"],
  vue: ["src/views/**/*.vue", "src/pages/**/*.vue"],
  generic: ["src/pages/**/*.tsx", "src/pages/**/*.jsx", "src/routes/**/*.tsx", "src/views/**/*.tsx"],
};

function readFileSafe(path: string, maxBytes = 10000): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.slice(0, maxBytes);
  } catch {
    return "";
  }
}

function detectFramework(deps: Record<string, string>): FrameworkInfo {
  for (const [pkg, info] of Object.entries(FRAMEWORKS)) {
    if (deps[pkg]) return info;
  }
  return { name: "generic", defaultPort: 3000, devScript: "dev" };
}

function detectStartCommand(scripts: Record<string, string>): string {
  if (scripts.dev) return "npm run dev";
  if (scripts.start) return "npm start";
  if (scripts.serve) return "npm run serve";
  return "npm run dev";
}

export async function analyzeProject(projectPath: string): Promise<ProjectInfo> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${projectPath}`);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFramework(allDeps);

  const startCommand = detectStartCommand(pkg.scripts || {});
  const startUrl = `http://localhost:${framework.defaultPort}`;

  // Read README
  const readme =
    readFileSafe(join(projectPath, "README.md"), 8000) ||
    readFileSafe(join(projectPath, "readme.md"), 8000);

  // Discover routes using find command
  const routePatterns = ROUTE_PATTERNS[framework.name] || ROUTE_PATTERNS.generic;
  const routes = await discoverRoutes(projectPath, routePatterns, framework.name);

  // Discover components
  const components = await discoverComponents(projectPath);

  // Read key files
  const keyFiles = readKeyFiles(projectPath, framework.name);

  return {
    name: pkg.name || basename(projectPath),
    framework: framework.name,
    startCommand,
    startUrl,
    routes,
    components,
    readme,
    keyFiles,
  };
}

async function discoverRoutes(
  projectPath: string,
  patterns: string[],
  framework: string,
): Promise<string[]> {
  const { execSync } = await import("node:child_process");
  const routes: string[] = [];

  for (const pattern of patterns) {
    try {
      const result = execSync(
        `find . -path "./${pattern}" -not -path "*/node_modules/*" 2>/dev/null | head -50`,
        { cwd: projectPath, encoding: "utf-8" },
      );
      for (const line of result.trim().split("\n")) {
        if (!line) continue;
        // Convert file path to route
        const route = filePathToRoute(line, framework);
        if (route) routes.push(route);
      }
    } catch {
      // Pattern didn't match anything
    }
  }

  // Also try grepping for route definitions
  if (routes.length === 0) {
    try {
      const result = execSync(
        `grep -rh "path:\\s*['\"]/" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null | head -20`,
        { cwd: projectPath, encoding: "utf-8" },
      );
      for (const line of result.trim().split("\n")) {
        const match = line.match(/path:\s*['"]([^'"]+)['"]/);
        if (match) routes.push(match[1]);
      }
    } catch {
      // No grep results
    }
  }

  return [...new Set(routes)].sort();
}

function filePathToRoute(filePath: string, framework: string): string | null {
  let route = filePath
    .replace(/^\.\//, "")
    .replace(/^(app|pages|src\/routes|src\/views|src\/pages)/, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\+page\.svelte$/, "")
    .replace(/\.(tsx|jsx|vue|svelte)$/, "")
    .replace(/\/index$/, "");

  if (!route.startsWith("/")) route = "/" + route;
  if (route === "/") return "/";

  // Skip internal/layout files
  if (route.includes("_app") || route.includes("_document") || route.includes("layout")) {
    return null;
  }

  return route;
}

async function discoverComponents(projectPath: string): Promise<string[]> {
  const { execSync } = await import("node:child_process");
  try {
    const result = execSync(
      `find src/components -name "*.tsx" -o -name "*.jsx" -o -name "*.vue" -o -name "*.svelte" 2>/dev/null | head -30`,
      { cwd: projectPath, encoding: "utf-8" },
    );
    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => basename(f).replace(/\.(tsx|jsx|vue|svelte)$/, ""));
  } catch {
    return [];
  }
}

function readKeyFiles(
  projectPath: string,
  framework: string,
): { path: string; content: string }[] {
  const candidates = [
    "src/App.tsx",
    "src/App.jsx",
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/main.tsx",
    "src/main.ts",
    "app/layout.tsx",
    "app/page.tsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "src/router/index.ts",
    "src/router/index.js",
  ];

  const files: { path: string; content: string }[] = [];
  let totalSize = 0;
  const MAX_TOTAL = 30000; // ~30KB total across all key files

  for (const candidate of candidates) {
    if (totalSize >= MAX_TOTAL) break;
    const fullPath = join(projectPath, candidate);
    const content = readFileSafe(fullPath, 5000);
    if (content) {
      files.push({ path: candidate, content });
      totalSize += content.length;
    }
  }

  return files;
}
