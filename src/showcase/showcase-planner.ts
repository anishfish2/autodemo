import type { ProjectInfo, DemoScenario } from "./showcase-types.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import { z } from "zod";

const DemoScenarioSchema = z.object({
  title: z.string(),
  description: z.string(),
  startPath: z.string().default("/"),
  order: z.number().int().positive(),
  interactionHints: z.array(z.string()).optional(),
  successCriteria: z.string().optional(),
});

const ShowcasePlanSchema = z.object({
  scenarios: z.array(DemoScenarioSchema),
});

function buildShowcaseSystemPrompt(): string {
  return `You are a product demo expert. Given detailed information about a web app — its file structure, routes, components, source code, UI features, and dependencies — plan a compelling video demo that showcases the app's most important features.

## What You Receive

- **File tree**: The project's directory structure
- **Framework & dependencies**: What the app is built with and notable libraries
- **Routes**: Discovered pages with metadata about what each contains (forms, data fetching, interactive elements)
- **API endpoints**: Backend routes the app exposes
- **UI features**: Detected patterns like auth, charts, data tables, modals
- **Source code**: Key files including page components, layouts, configs
- **README**: Project description and documentation

## How to Plan

1. **Understand the product** first. Read the README and source code to grasp what this app does and who it's for.
2. **Identify the hero features** — what would a potential user or investor most want to see? These are usually the routes with interactive elements, data display, or unique functionality.
3. **Build a narrative** — don't just list features randomly. Order scenarios to tell a story: start with first impressions (homepage/landing), then walk through the core workflow, then show secondary features.
4. **Write specific instructions** — use information from the source code to reference exact button text, form field labels, navigation items, and expected content. The agent executing these will be looking at the screen, so describe what to look for and interact with.

## Rules

1. Each scenario should be achievable in 1-2 minutes (5-15 agent steps)
2. Start with the homepage/landing page to establish context
3. If the app has auth, include login early (only if test credentials are provided in instructions)
4. Focus on user-facing features — skip admin panels, settings, and dev tools unless they're a main feature
5. Reference specific UI elements from the source code: button text, form labels, navigation items, headings
6. For forms, specify what data to enter (use realistic but fake data)
7. Include interactionHints listing the key elements to interact with (button text, link text, form fields)
8. Include successCriteria describing what the screen should show when the scenario is complete
9. Limit to the most compelling scenarios — quality over quantity

## Response Format

Respond with a JSON object (no markdown fences):

{
  "scenarios": [
    {
      "title": "Homepage Overview",
      "description": "Navigate to the homepage. Scroll down slowly through all sections to showcase the layout...",
      "startPath": "/",
      "order": 1,
      "interactionHints": ["Hero section heading", "Features grid", "Call-to-action button"],
      "successCriteria": "The full homepage has been scrolled through showing all sections"
    }
  ]
}`;
}

function buildShowcaseUserPrompt(info: ProjectInfo): string {
  let prompt = `## Project: ${info.name}\n`;
  prompt += `**Framework**: ${info.framework}\n`;
  prompt += `**Package manager**: ${info.packageManager}\n\n`;

  if (info.notableDependencies.length > 0) {
    prompt += `## Notable Dependencies\n`;
    prompt += info.notableDependencies.join(", ") + "\n\n";
  }

  if (info.readme) {
    prompt += `## README\n${info.readme}\n\n`;
  }

  if (info.fileTree) {
    prompt += `## File Structure\n\`\`\`\n${info.fileTree}\n\`\`\`\n\n`;
  }

  if (!info.fileTree && !info.readme && info.routes.length === 0) {
    prompt += `## Note\nNo source code is available — this is a live URL. Plan scenarios based on the URL and any user instructions. The agent will explore the site visually.\n\n`;
  }

  if (info.routes.length > 0) {
    prompt += `## Routes/Pages\n`;
    for (const route of info.routes) {
      const traits: string[] = [];
      if (route.hasForm) traits.push("has forms");
      if (route.hasDataFetching) traits.push("fetches data");
      if (route.hasInteractiveElements) traits.push("interactive");
      if (route.title) traits.push(`title: "${route.title}"`);
      const traitStr = traits.length > 0 ? ` (${traits.join(", ")})` : "";
      prompt += `- \`${route.path}\`${traitStr} — ${route.filePath}\n`;
    }
    prompt += "\n";
  }

  if (info.apiEndpoints.length > 0) {
    prompt += `## API Endpoints\n`;
    for (const ep of info.apiEndpoints) {
      prompt += `- ${ep}\n`;
    }
    prompt += "\n";
  }

  if (info.uiFeatures.details.length > 0) {
    prompt += `## Detected UI Features\n`;
    for (const f of info.uiFeatures.details) {
      prompt += `- **${f.feature}**: ${f.evidence}\n`;
    }
    prompt += "\n";
  }

  if (info.components.length > 0) {
    prompt += `## Components\n`;
    prompt += info.components.join(", ") + "\n\n";
  }

  if (info.keyFiles.length > 0) {
    prompt += `## Key Source Files\n`;
    for (const file of info.keyFiles) {
      prompt += `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
    }
  }

  prompt += `\nPlan the demo scenarios. Respond with JSON.`;
  return prompt;
}

export async function planShowcase(
  info: ProjectInfo,
  model: string,
  logger: Logger,
  maxScenarios: number,
  instructions?: string,
): Promise<DemoScenario[]> {
  const client = new Anthropic();
  const systemPrompt = buildShowcaseSystemPrompt();
  let userPrompt = buildShowcaseUserPrompt(info);

  if (instructions) {
    userPrompt += `\n\n## Additional Instructions from User\n${instructions}\n\nUse these details (credentials, context, preferences) in your demo scenarios where relevant.`;
  }

  logger.info("Generating showcase plan from codebase analysis...");

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const content = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Parse the response
  const jsonStr = extractJson(content);
  const parsed = JSON.parse(jsonStr);
  const validated = ShowcasePlanSchema.parse(parsed);

  // Sort by order and limit
  const scenarios = validated.scenarios
    .sort((a, b) => a.order - b.order)
    .slice(0, maxScenarios);

  logger.info({ count: scenarios.length }, "Showcase plan generated");

  return scenarios;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  throw new Error("Could not extract JSON from showcase planner response");
}
