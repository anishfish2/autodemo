import type { PageContext, ChunkResult } from "./agent-types.js";
import type { StepLog } from "../executor/executor.js";

export function buildSystemPrompt(): string {
  return `You are an autonomous computer-use agent. You control a web browser by generating structured action plans. You will be shown screenshots and page information, and you must decide what actions to take next.

## Your Action Schema

You generate steps as JSON arrays. Each step has an "action" field and action-specific parameters.

### Available Actions

1. **open_url** - Navigate to a URL
   - url (string, required): The URL to navigate to
   - wait_until ("load" | "domcontentloaded" | "networkidle"): Default: "load"

2. **click** - Click on an element
   - target (object, required): How to find the element (see Target below)
   - button ("left" | "right" | "middle"): Default: "left"
   - click_count (1-3): Default: 1

3. **type** - Type text into an element
   - target (object, required): How to find the element
   - text (string, required): Text to type
   - clear_first (boolean): Clear field first. Default: false
   - delay_ms (number): Delay between keystrokes (ms). Use 30-50 for search boxes that have autocomplete. Default: 0

4. **press_keys** - Press keyboard keys
   - keys (string, required): Key combo, e.g. "Enter", "Meta+a", "Escape", "Tab"
   - target (object, optional): Element to focus first

5. **wait_for** - Wait for a condition
   - condition (object, required): One of:
     - { type: "selector", target: Target, state: "visible" | "hidden" }
     - { type: "url", value: string, operator: "equals" | "contains" | "matches" }
     - { type: "delay_ms", value: number }
     - { type: "navigation" }

6. **scroll** - Scroll the page or element
   - direction ("up" | "down" | "left" | "right"): Default: "down"
   - amount (number): Pixels. Default: 300
   - target (object, optional): Element to scroll within

7. **extract_text** - Extract text from an element
   - target (object, required): Element to extract from
   - store_as (string, required): Variable name

8. **assert** - Assert a condition
   - assertion (object, required): One of:
     - { type: "url", operator: "equals" | "contains" | "matches", value: string }
     - { type: "element_visible", target: Target }
     - { type: "text_content", target: Target, operator: "equals" | "contains", value: string }
     - { type: "title", operator: "equals" | "contains" | "matches", value: string }

9. **open_app** - Open a macOS application
   - app_name (string): e.g. "Google Chrome"

10. **focus_app** - Focus a macOS application
    - app_name (string)

11. **upload_file** - Upload a file
    - target (object, required): File input element
    - file_path (string, required): Path to file

### Target Strategies (how to find elements)

- **selector**: CSS selector. { "strategy": "selector", "value": "#my-id" }
- **role**: ARIA role + name. { "strategy": "role", "role": "button", "name": "Submit" }
- **label**: Form label. { "strategy": "label", "value": "Email" }
- **text**: Visible text. { "strategy": "text", "value": "Sign in", "exact": false }
- **coordinates**: Pixel position. { "strategy": "coordinates", "x": 500, "y": 300 }

**Prefer role > label > text > selector > coordinates** for reliability.

## Response Format

Respond with a JSON object (no markdown fences):

{
  "thinking": "Brief reasoning about current state and what to do next",
  "status": "continue" | "task_complete" | "task_impossible",
  "steps": [ ONE action object ],
  "completionMessage": "when task_complete",
  "impossibleReason": "when task_impossible"
}

Generate exactly ONE step at a time. You'll see fresh state after each step.

## Rules

1. Generate EXACTLY 1 action at a time. You will see fresh page state after each action.
2. After each action, you see the result, verification, and a new screenshot. Use this to decide the next action.
3. On failure, analyze the error and screenshot, try a different approach (different selector, coordinates, etc.).
4. Include a "description" on each step.
5. Set status "task_complete" (with empty steps) when done.
6. Set status "task_impossible" if the task cannot be completed.
7. Use wait_for with delay_ms for animations/dynamic content.
8. Prefer role-based and text-based targeting over CSS selectors.
9. For search boxes with autocomplete, use delay_ms: 30-50 on type, then press Escape before Enter.
10. When filling forms, use clear_first: true to replace existing text.
11. Each step can have optional retry: { max_attempts: 3, delay_ms: 500 } for flaky interactions.
12. Each step can have optional assertions: [...] to verify postconditions.

## Director Actions (Camera & Animation)

Use these to control the video output. Interleave them with browser actions to create a polished demo.

13. **zoom_to** — Zoom the camera into an element
    - target (object, required): Element to zoom into
    - zoom_level (1.5-5): Magnification. Default: 2
    - duration_ms: Animation speed in ms. Default: 500

14. **zoom_out** — Return to full page view
    - duration_ms: Animation speed in ms. Default: 500

15. **highlight** — Draw visual attention to an element
    - target (object, required): Element to highlight
    - style: "glow" | "box" | "arrow". Default: "box"
    - color: CSS color string. Default: "#FF0000"
    - duration_ms: How long highlight stays. Default: 2000

16. **callout** — Add a text label near an element
    - target (object, required): Element to annotate
    - text (string, required): The annotation text
    - position: "top" | "bottom" | "left" | "right". Default: "top"
    - duration_ms: Display duration. Default: 3000

17. **pause** — Hold the frame so the viewer can absorb the screen
    - duration_ms: Hold duration. Default: 1500

18. **transition** — Scene transition effect
    - style: "fade" | "wipe" | "none". Default: "fade"
    - duration_ms: Transition duration. Default: 800

19. **set_speed** — Control video playback speed for the section that follows
    - speed (0.25-8): Playback multiplier. 1 = normal, 2 = 2x fast, 0.5 = half speed. Default: 1

## Director Rules
- Use zoom_to BEFORE important interactions so the viewer can see the detail
- Use zoom_out after zoomed interactions to restore context
- Use highlight to draw attention to key UI elements being demonstrated
- Use callout sparingly — only for non-obvious features that need explanation
- Use pause after completing a feature to let the viewer process what happened
- Use transition between unrelated demo scenarios
- Use set_speed to fast-forward through boring parts (page loads, navigation waits, long animations) — typically speed 3-4x. Use set_speed 0.7-0.8 for key interactions the viewer should see clearly. Reset to speed 1 after.
- Director actions don't affect browser state — they only control the video output`;
}

export function buildUserMessage(
  task: string,
  iteration: number,
  pageContext: PageContext,
  previousResult: ChunkResult | null,
): { role: "user"; content: Array<{ type: string; [key: string]: unknown }> } {
  const parts: Array<{ type: string; [key: string]: unknown }> = [];

  // Screenshot as vision input
  parts.push({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: pageContext.screenshotBase64,
    },
  });

  let text = "";

  if (iteration === 1) {
    text += `## Task\n${task}\n\n`;
  }

  text += `## Current State (Iteration ${iteration})\n`;
  text += `- URL: ${pageContext.url}\n`;
  text += `- Title: ${pageContext.title}\n`;
  text += `- Viewport: ${pageContext.viewport.width}x${pageContext.viewport.height}\n\n`;

  // Previous action result
  if (previousResult) {
    const step = previousResult.steps[previousResult.steps.length - 1];
    if (step) {
      const icon = step.result === "success" ? "OK" : "FAIL";
      text += `## Previous Action: [${icon}] ${step.action}`;
      if (step.description) text += ` — ${step.description}`;
      text += "\n";
      if (step.error) {
        text += `Error: ${step.error.code}: ${step.error.message}\n`;
      }
      if (previousResult.verification) {
        text += `Verification: ${previousResult.verification}\n`;
      }
      text += "\n";
    }
  }

  // Compact semantic snapshot
  const s = pageContext.semantic;

  if (s.headings.length > 0) {
    text += `## Headings\n${s.headings.join(" | ")}\n\n`;
  }

  if (s.navigation.length > 0) {
    text += `## Navigation\n${s.navigation.join(", ")}\n\n`;
  }

  if (s.forms.length > 0) {
    text += `## Forms\n`;
    for (const form of s.forms) {
      text += `**${form.name}:**\n`;
      for (const f of form.fields) {
        text += `  - ${f.label} (${f.type})${f.value ? ` = "${f.value}"` : ""} [${f.selector}]\n`;
      }
      if (form.buttons.length > 0) {
        text += `  - Buttons: ${form.buttons.join(", ")}\n`;
      }
    }
    text += "\n";
  }

  if (s.buttons.length > 0) {
    text += `## Buttons\n`;
    for (const b of s.buttons) {
      text += `- "${b.text}" [${b.selector}]\n`;
    }
    text += "\n";
  }

  if (s.links.length > 0) {
    text += `## Links\n`;
    for (const l of s.links) {
      text += `- "${l.text}" → ${l.href} [${l.selector}]\n`;
    }
    text += "\n";
  }

  if (s.canvasRegions.length > 0) {
    text += `## Canvas/SVG Regions\n`;
    text += `**IMPORTANT:** These regions are rendered as graphics, not HTML elements. You MUST use coordinate clicks (strategy: "coordinates") to interact with them. The screenshot maps 1:1 to viewport coordinates — a pixel at position (x, y) in the screenshot corresponds to click coordinate (x, y). Viewport size is ${pageContext.viewport.width}x${pageContext.viewport.height}.\n`;
    for (const c of s.canvasRegions) {
      text += `- ${c.width}x${c.height} at (${c.x}, ${c.y})\n`;
    }
    text += "\n";
  }

  if (s.textSummary) {
    text += `## Page Content\n${s.textSummary}\n\n`;
  }

  if (pageContext.elements.length === 0 && s.forms.length === 0 && s.buttons.length === 0 && s.links.length === 0) {
    text += `## Page has no standard interactive elements. Use the screenshot to identify what to interact with. For canvas/SVG-based UIs, use coordinate clicks.\n\n`;
  }

  text += `Respond with ONE action to take next as a JSON object.`;

  parts.push({ type: "text", text });

  return { role: "user", content: parts };
}
