import type { ProjectInfo, DemoScenario } from "./showcase-types.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import { z } from "zod";

const DemoScenarioSchema = z.object({
  title: z.string(),
  description: z.string(),
  startPath: z.string().default("/"),
  order: z.number().int().positive(),
});

const ShowcasePlanSchema = z.object({
  scenarios: z.array(DemoScenarioSchema),
});

function buildShowcaseSystemPrompt(): string {
  return `You are a product demo expert. Given a web app's codebase information, plan a compelling video demo that shows off the app's features.

## Your Task

Analyze the project's routes, components, README, and source code to identify the most impressive and demoable features. Then create an ordered list of demo scenarios.

## Rules

1. Order scenarios from most visually impressive to least
2. Always start with the homepage / landing page overview
3. Focus on user-facing features (forms, navigation, interactive UI)
4. Each scenario should be a self-contained task the agent can perform
5. Write descriptions as natural language instructions (the agent will execute them)
6. Keep each scenario achievable in 1-2 minutes (5-15 agent steps)
7. Skip admin panels, settings pages, and developer tools unless they're a main feature
8. If the app requires auth, include a login/signup flow early
9. Include specific details from the code (route paths, button names, form fields) so the agent knows exactly what to interact with
10. Limit to the most compelling scenarios — quality over quantity

## Response Format

Respond with a JSON object (no markdown fences):

{
  "scenarios": [
    {
      "title": "Homepage Overview",
      "description": "Navigate to the homepage. Scroll down slowly to see all sections. Click on key navigation links to explore the layout.",
      "startPath": "/",
      "order": 1
    },
    ...
  ]
}`;
}

function buildShowcaseUserPrompt(info: ProjectInfo): string {
  let prompt = `## Project: ${info.name}\n`;
  prompt += `**Framework**: ${info.framework}\n\n`;

  if (info.readme) {
    prompt += `## README\n${info.readme}\n\n`;
  }

  if (info.routes.length > 0) {
    prompt += `## Routes/Pages\n`;
    for (const route of info.routes) {
      prompt += `- ${route}\n`;
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

  logger.info(
    { count: scenarios.length },
    "Showcase plan generated",
  );

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
