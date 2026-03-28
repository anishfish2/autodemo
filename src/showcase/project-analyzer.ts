import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { execSync } from "node:child_process";
import type { ProjectInfo, RouteInfo, UIFeatures } from "./showcase-types.js";

// --- Package Manager Detection ---

function detectPackageManager(
  projectPath: string,
): "npm" | "yarn" | "pnpm" | "bun" {
  if (existsSync(join(projectPath, "bun.lockb"))) return "bun";
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function runCmd(pm: string): string {
  if (pm === "npm") return "npm run";
  if (pm === "yarn") return "yarn";
  if (pm === "pnpm") return "pnpm";
  return "bun run";
}

// --- Framework Detection ---

interface FrameworkInfo {
  name: string;
  defaultPort: number;
  devScript: string;
}

const CONFIG_FILE_FRAMEWORKS: Array<{
  files: string[];
  info: FrameworkInfo;
}> = [
  {
    files: ["next.config.js", "next.config.mjs", "next.config.ts"],
    info: { name: "nextjs", defaultPort: 3000, devScript: "dev" },
  },
  {
    files: ["nuxt.config.ts", "nuxt.config.js"],
    info: { name: "nuxt", defaultPort: 3000, devScript: "dev" },
  },
  {
    files: ["svelte.config.js", "svelte.config.ts"],
    info: { name: "sveltekit", defaultPort: 5173, devScript: "dev" },
  },
  {
    files: ["astro.config.mjs", "astro.config.ts"],
    info: { name: "astro", defaultPort: 4321, devScript: "dev" },
  },
  {
    files: ["remix.config.js", "remix.config.ts"],
    info: { name: "remix", defaultPort: 3000, devScript: "dev" },
  },
  {
    files: ["angular.json"],
    info: { name: "angular", defaultPort: 4200, devScript: "start" },
  },
  {
    files: ["gatsby-config.js", "gatsby-config.ts"],
    info: { name: "gatsby", defaultPort: 8000, devScript: "develop" },
  },
  {
    files: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
    info: { name: "vite", defaultPort: 5173, devScript: "dev" },
  },
];

const DEP_FRAMEWORKS: Record<string, FrameworkInfo> = {
  next: { name: "nextjs", defaultPort: 3000, devScript: "dev" },
  nuxt: { name: "nuxt", defaultPort: 3000, devScript: "dev" },
  "@sveltejs/kit": { name: "sveltekit", defaultPort: 5173, devScript: "dev" },
  astro: { name: "astro", defaultPort: 4321, devScript: "dev" },
  remix: { name: "remix", defaultPort: 3000, devScript: "dev" },
  "@remix-run/dev": { name: "remix", defaultPort: 3000, devScript: "dev" },
  "@angular/core": { name: "angular", defaultPort: 4200, devScript: "start" },
  gatsby: { name: "gatsby", defaultPort: 8000, devScript: "develop" },
  "react-scripts": { name: "cra", defaultPort: 3000, devScript: "start" },
  vue: { name: "vue", defaultPort: 5173, devScript: "dev" },
  svelte: { name: "svelte", defaultPort: 5173, devScript: "dev" },
};

function detectFramework(
  projectPath: string,
  deps: Record<string, string>,
): FrameworkInfo {
  // Config files take priority — they're definitive
  for (const { files, info } of CONFIG_FILE_FRAMEWORKS) {
    for (const file of files) {
      if (existsSync(join(projectPath, file))) return info;
    }
  }

  // Fall back to dependency detection
  for (const [pkg, info] of Object.entries(DEP_FRAMEWORKS)) {
    if (deps[pkg]) return info;
  }

  return { name: "generic", defaultPort: 3000, devScript: "dev" };
}

// --- Start Command & Port Detection ---

function detectStartCommand(
  scripts: Record<string, string>,
  framework: FrameworkInfo,
  pm: string,
): string {
  const run = runCmd(pm);

  // Prefer the framework's expected script name
  if (scripts[framework.devScript]) return `${run} ${framework.devScript}`;

  // Common fallbacks
  for (const name of ["dev", "start", "serve", "develop"]) {
    if (scripts[name]) return `${run} ${name}`;
  }

  return `${run} dev`;
}

function detectPort(
  projectPath: string,
  scripts: Record<string, string>,
  framework: FrameworkInfo,
): number {
  // Check .env and .env.local for PORT=
  for (const envFile of [".env.local", ".env", ".env.development"]) {
    const envPath = join(projectPath, envFile);
    const content = readFileSafe(envPath, 2000);
    const match = content.match(/^PORT\s*=\s*(\d+)/m);
    if (match) return parseInt(match[1], 10);
  }

  // Check dev script content for port flags
  const devScript =
    scripts[framework.devScript] || scripts.dev || scripts.start || "";
  const portMatch = devScript.match(
    /(?:--port|-p)\s+(\d+)|PORT=(\d+)|:(\d{4,5})/,
  );
  if (portMatch) {
    const port = parseInt(portMatch[1] || portMatch[2] || portMatch[3], 10);
    if (port > 0 && port < 65536) return port;
  }

  // Check framework config files for port
  for (const configFile of [
    "vite.config.ts",
    "vite.config.js",
    "next.config.js",
    "next.config.mjs",
  ]) {
    const content = readFileSafe(join(projectPath, configFile), 5000);
    const match = content.match(/port\s*:\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
  }

  return framework.defaultPort;
}

// --- File Tree ---

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  "dist",
  "build",
  ".output",
  ".cache",
  ".turbo",
  "coverage",
  ".vercel",
  ".netlify",
]);

function buildFileTree(projectPath: string, maxChars = 4000): string {
  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (lines.join("\n").length > maxChars) return;
    if (depth > 5) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    // Filter ignored dirs and hidden files (except config dotfiles at root)
    entries = entries.filter((e) => {
      if (IGNORE_DIRS.has(e)) return false;
      if (e.startsWith(".") && depth > 0) return false;
      return true;
    });

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        lines.push(`${prefix}${entry}/`);
        walk(fullPath, prefix + "  ", depth + 1);
      } else {
        lines.push(`${prefix}${entry}`);
      }
    }
  }

  walk(projectPath, "", 0);

  const result = lines.join("\n");
  return result.length > maxChars
    ? result.slice(0, maxChars) + "\n... (truncated)"
    : result;
}

// --- Route Discovery ---

const ROUTE_PATTERNS: Record<string, string[]> = {
  nextjs: [
    "app/**/page.tsx",
    "app/**/page.jsx",
    "app/**/page.ts",
    "app/**/page.js",
    "pages/**/*.tsx",
    "pages/**/*.jsx",
    "src/app/**/page.tsx",
    "src/app/**/page.jsx",
  ],
  nuxt: ["pages/**/*.vue"],
  sveltekit: ["src/routes/**/+page.svelte"],
  remix: ["app/routes/**/*.tsx", "app/routes/**/*.jsx"],
  vue: ["src/views/**/*.vue", "src/pages/**/*.vue"],
  gatsby: ["src/pages/**/*.tsx", "src/pages/**/*.jsx"],
  angular: ["src/app/**/*.component.ts"],
  generic: [
    "src/pages/**/*.tsx",
    "src/pages/**/*.jsx",
    "src/routes/**/*.tsx",
    "src/views/**/*.tsx",
  ],
};

const API_ROUTE_PATTERNS: Record<string, string[]> = {
  nextjs: ["app/api/**/route.ts", "app/api/**/route.js", "pages/api/**/*.ts", "pages/api/**/*.js", "src/app/api/**/route.ts"],
  nuxt: ["server/api/**/*.ts", "server/api/**/*.js"],
  sveltekit: ["src/routes/api/**/*.ts", "src/routes/**/+server.ts"],
  remix: ["app/routes/api.*.tsx", "app/routes/api.*.ts"],
  generic: ["src/api/**/*.ts", "server/**/*.ts", "api/**/*.ts"],
};

function filePathToRoute(filePath: string, framework: string): string | null {
  let route = filePath
    .replace(/^\.\//, "")
    .replace(
      /^(src\/app|app|pages|src\/routes|src\/views|src\/pages)/,
      "",
    )
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\+page\.svelte$/, "")
    .replace(/\.(tsx|jsx|vue|svelte|ts|js)$/, "")
    .replace(/\/index$/, "");

  // Next.js route groups: strip (groupName)
  route = route.replace(/\/\([^)]+\)/g, "");

  if (!route.startsWith("/")) route = "/" + route;
  if (route === "/") return "/";

  // Skip internal files
  if (
    route.includes("_app") ||
    route.includes("_document") ||
    route.includes("layout") ||
    route.includes("loading") ||
    route.includes("error") ||
    route.includes("not-found")
  ) {
    return null;
  }

  return route;
}

function findFiles(projectPath: string, pattern: string): string[] {
  try {
    const result = execSync(
      `find . -path "./${pattern}" -not -path "*/node_modules/*" 2>/dev/null | head -50`,
      { cwd: projectPath, encoding: "utf-8" },
    );
    return result
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const FORM_PATTERNS =
  /<form|<input|<select|<textarea|onSubmit|handleSubmit|useForm|formik|react-hook-form/i;
const DATA_FETCH_PATTERNS =
  /getServerSideProps|getStaticProps|loader\s*\(|useQuery|useSWR|fetch\(|axios\.|trpc\./i;
const INTERACTIVE_PATTERNS =
  /<button|onClick|<Modal|<Dialog|<Drawer|<Popover|<Dropdown|<Accordion|<Tab/i;

function analyzeRouteFile(filePath: string): {
  hasForm: boolean;
  hasDataFetching: boolean;
  hasInteractiveElements: boolean;
  title?: string;
} {
  const content = readFileSafe(filePath, 8000);
  if (!content) {
    return {
      hasForm: false,
      hasDataFetching: false,
      hasInteractiveElements: false,
    };
  }

  // Try to extract page title from headings or metadata
  let title: string | undefined;
  const titleMatch =
    content.match(/(?:<h1[^>]*>|title:\s*["'])([^<"']+)/) ||
    content.match(/export\s+const\s+metadata\s*=\s*\{[^}]*title:\s*["']([^"']+)/);
  if (titleMatch) title = titleMatch[1].trim();

  return {
    hasForm: FORM_PATTERNS.test(content),
    hasDataFetching: DATA_FETCH_PATTERNS.test(content),
    hasInteractiveElements: INTERACTIVE_PATTERNS.test(content),
    title,
  };
}

async function discoverRoutes(
  projectPath: string,
  framework: string,
): Promise<RouteInfo[]> {
  const patterns =
    ROUTE_PATTERNS[framework] || ROUTE_PATTERNS.generic;
  const routes: RouteInfo[] = [];
  const seenPaths = new Set<string>();

  for (const pattern of patterns) {
    const files = findFiles(projectPath, pattern);
    for (const file of files) {
      const routePath = filePathToRoute(file, framework);
      if (!routePath || seenPaths.has(routePath)) continue;
      seenPaths.add(routePath);

      const fullPath = join(projectPath, file.replace(/^\.\//, ""));
      const analysis = analyzeRouteFile(fullPath);

      routes.push({
        path: routePath,
        filePath: file.replace(/^\.\//, ""),
        ...analysis,
      });
    }
  }

  // Fallback: grep for router definitions if no file-based routes found
  if (routes.length === 0) {
    try {
      const result = execSync(
        `grep -rh "path:\\s*['\"/]" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null | head -30`,
        { cwd: projectPath, encoding: "utf-8" },
      );
      for (const line of result.trim().split("\n")) {
        const match = line.match(/path:\s*['"]([^'"]+)['"]/);
        if (match && !seenPaths.has(match[1])) {
          seenPaths.add(match[1]);
          routes.push({
            path: match[1],
            filePath: "",
            hasForm: false,
            hasDataFetching: false,
            hasInteractiveElements: false,
          });
        }
      }
    } catch {}
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function discoverApiEndpoints(
  projectPath: string,
  framework: string,
): string[] {
  const patterns =
    API_ROUTE_PATTERNS[framework] || API_ROUTE_PATTERNS.generic;
  const endpoints: string[] = [];

  for (const pattern of patterns) {
    const files = findFiles(projectPath, pattern);
    for (const file of files) {
      // Convert file path to API route
      let endpoint = file
        .replace(/^\.\//, "")
        .replace(/^(src\/app|app|pages|src\/routes|server)/, "")
        .replace(/\/route\.(ts|js)$/, "")
        .replace(/\.(ts|js|tsx|jsx)$/, "");
      if (!endpoint.startsWith("/")) endpoint = "/" + endpoint;
      endpoints.push(endpoint);
    }
  }

  return [...new Set(endpoints)].sort();
}

// --- Component Discovery ---

function discoverComponents(projectPath: string): string[] {
  const dirs = [
    "src/components",
    "components",
    "src/ui",
    "app/components",
  ];
  const components: string[] = [];

  for (const dir of dirs) {
    try {
      const result = execSync(
        `find ${dir} \\( -name "*.tsx" -o -name "*.jsx" -o -name "*.vue" -o -name "*.svelte" \\) 2>/dev/null | head -40`,
        { cwd: projectPath, encoding: "utf-8" },
      );
      for (const line of result.trim().split("\n")) {
        if (!line) continue;
        components.push(
          basename(line).replace(/\.(tsx|jsx|vue|svelte)$/, ""),
        );
      }
    } catch {}
  }

  return [...new Set(components)].sort();
}

// --- UI Feature Extraction ---

function extractUIFeatures(
  projectPath: string,
  routes: RouteInfo[],
): UIFeatures {
  const features: UIFeatures = {
    hasForms: false,
    hasAuth: false,
    hasNavigation: false,
    hasDataTables: false,
    hasCharts: false,
    hasModals: false,
    hasMedia: false,
    details: [],
  };

  // Check from route analysis
  features.hasForms = routes.some((r) => r.hasForm);

  // Scan source files for feature patterns
  const featurePatterns: Array<{
    key: keyof UIFeatures;
    pattern: RegExp;
    label: string;
  }> = [
    {
      key: "hasAuth",
      pattern:
        /useAuth|useSession|signIn|signOut|<Login|<Auth|next-auth|clerk|supabase.*auth|firebase.*auth|passport/i,
      label: "Authentication",
    },
    {
      key: "hasNavigation",
      pattern: /<nav|<Sidebar|<Header|<Navbar|<Navigation|<Menu|<Breadcrumb/i,
      label: "Navigation",
    },
    {
      key: "hasDataTables",
      pattern:
        /<table|<Table|<DataGrid|<DataTable|@tanstack\/table|ag-grid|react-table/i,
      label: "Data tables",
    },
    {
      key: "hasCharts",
      pattern:
        /recharts|chart\.js|d3|visx|nivo|<Chart|<Bar|<Line|<Pie|<AreaChart|apexcharts|plotly/i,
      label: "Charts/visualizations",
    },
    {
      key: "hasModals",
      pattern: /<Modal|<Dialog|<Drawer|<Sheet|<Popover|<AlertDialog/i,
      label: "Modals/dialogs",
    },
    {
      key: "hasMedia",
      pattern:
        /<video|<Video|<Image|<Gallery|<Carousel|<Slider|<Player/i,
      label: "Media elements",
    },
  ];

  // Grep source files for each pattern
  for (const { key, pattern, label } of featurePatterns) {
    try {
      const grepPattern = pattern.source
        .replace(/\|/g, "\\|")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
        .replace(/\.\*/g, ".*");

      const result = execSync(
        `grep -rl "${grepPattern}" src/ app/ pages/ --include="*.tsx" --include="*.jsx" --include="*.ts" --include="*.vue" 2>/dev/null | head -10`,
        { cwd: projectPath, encoding: "utf-8" },
      );
      const matchingFiles = result.trim().split("\n").filter(Boolean);
      if (matchingFiles.length > 0) {
        (features as unknown as Record<string, unknown>)[key] = true;
        features.details.push({
          feature: label,
          routes: matchingFiles.slice(0, 5),
          evidence: `Found in ${matchingFiles.length} file(s)`,
        });
      }
    } catch {
      // grep returns exit code 1 when no matches — that's fine
    }
  }

  return features;
}

// --- Notable Dependencies ---

const NOTABLE_DEPS = new Set([
  // UI frameworks
  "@mui/material",
  "@chakra-ui/react",
  "antd",
  "@mantine/core",
  "@radix-ui/react-dialog",
  "shadcn",
  "@headlessui/react",
  "tailwindcss",
  "bootstrap",
  // Data/state
  "@tanstack/react-query",
  "swr",
  "zustand",
  "redux",
  "@reduxjs/toolkit",
  "jotai",
  "recoil",
  // Forms
  "react-hook-form",
  "formik",
  "zod",
  "yup",
  // Charts
  "recharts",
  "chart.js",
  "d3",
  "@visx/visx",
  "@nivo/core",
  "apexcharts",
  // Auth
  "next-auth",
  "@auth/core",
  "@clerk/nextjs",
  "firebase",
  "@supabase/supabase-js",
  // Data tables
  "@tanstack/react-table",
  "ag-grid-react",
  // Animation
  "framer-motion",
  "gsap",
  // Maps
  "mapbox-gl",
  "react-map-gl",
  "@react-google-maps/api",
  // Rich text
  "tiptap",
  "@tiptap/react",
  "slate",
  "prosemirror",
  "quill",
]);

function detectNotableDeps(deps: Record<string, string>): string[] {
  return Object.keys(deps)
    .filter((d) => NOTABLE_DEPS.has(d))
    .sort();
}

// --- Key File Selection ---

function readKeyFiles(
  projectPath: string,
  framework: string,
  routes: RouteInfo[],
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  let totalSize = 0;
  const MAX_TOTAL = 40000;
  const MAX_PER_FILE = 5000;

  function addFile(relPath: string): void {
    if (totalSize >= MAX_TOTAL) return;
    const fullPath = join(projectPath, relPath);
    const content = readFileSafe(fullPath, MAX_PER_FILE);
    if (content && !files.some((f) => f.path === relPath)) {
      files.push({ path: relPath, content });
      totalSize += content.length;
    }
  }

  // 1. Framework config
  for (const { files: configFiles } of CONFIG_FILE_FRAMEWORKS) {
    for (const cf of configFiles) {
      if (existsSync(join(projectPath, cf))) {
        addFile(cf);
        break;
      }
    }
  }

  // 2. Root layout / app entry
  const entryPoints = [
    "src/App.tsx",
    "src/App.jsx",
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "app/layout.tsx",
    "app/page.tsx",
    "src/main.tsx",
    "src/main.ts",
    "src/index.tsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "pages/_app.tsx",
    "src/router/index.ts",
    "src/router/index.js",
  ];
  for (const ep of entryPoints) {
    addFile(ep);
  }

  // 3. Route page files (most interesting ones first)
  const interestingRoutes = routes
    .filter((r) => r.filePath)
    .sort(
      (a, b) =>
        Number(b.hasForm) +
        Number(b.hasDataFetching) +
        Number(b.hasInteractiveElements) -
        (Number(a.hasForm) +
          Number(a.hasDataFetching) +
          Number(a.hasInteractiveElements)),
    );

  for (const route of interestingRoutes.slice(0, 8)) {
    addFile(route.filePath);
  }

  // 4. Env example
  for (const envFile of [".env.example", ".env.local.example"]) {
    addFile(envFile);
  }

  // 5. Tailwind / CSS config
  for (const cssConfig of ["tailwind.config.ts", "tailwind.config.js"]) {
    addFile(cssConfig);
  }

  return files;
}

// --- Helpers ---

function readFileSafe(path: string, maxBytes = 10000): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.slice(0, maxBytes);
  } catch {
    return "";
  }
}

// --- Main Analyzer ---

export async function analyzeProject(
  projectPath: string,
): Promise<ProjectInfo> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${projectPath}`);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const packageManager = detectPackageManager(projectPath);
  const framework = detectFramework(projectPath, allDeps);
  const scripts: Record<string, string> = pkg.scripts || {};

  const startCommand = detectStartCommand(scripts, framework, packageManager);
  const port = detectPort(projectPath, scripts, framework);
  const startUrl = `http://localhost:${port}`;

  const readme =
    readFileSafe(join(projectPath, "README.md"), 8000) ||
    readFileSafe(join(projectPath, "readme.md"), 8000);

  const fileTree = buildFileTree(projectPath);
  const routes = await discoverRoutes(projectPath, framework.name);
  const apiEndpoints = discoverApiEndpoints(projectPath, framework.name);
  const components = discoverComponents(projectPath);
  const uiFeatures = extractUIFeatures(projectPath, routes);
  const keyFiles = readKeyFiles(projectPath, framework.name, routes);
  const notableDependencies = detectNotableDeps(allDeps);

  return {
    name: pkg.name || basename(projectPath),
    framework: framework.name,
    packageManager,
    startCommand,
    port,
    startUrl,
    routes,
    apiEndpoints,
    components,
    uiFeatures,
    fileTree,
    readme,
    keyFiles,
    notableDependencies,
  };
}
