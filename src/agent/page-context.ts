import type { Page } from "playwright";
import { readFileSync } from "node:fs";
import type { PageContext, PageElement, SemanticSnapshot } from "./agent-types.js";

export async function extractPageContext(
  page: Page,
  screenshotPath: string,
): Promise<PageContext> {
  const url = page.url();
  const title = await page.title();
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };

  const { elements, semantic } = await extractPageData(page);

  // If there are canvas/SVG regions, add a coordinate grid overlay
  // to help the LLM map visual positions to exact pixel coordinates
  let screenshotBase64: string;
  if (semantic.canvasRegions.length > 0) {
    // Draw grid overlay on the page, take screenshot, then remove it
    await page.evaluate((vp) => {
      const overlay = document.createElement("div");
      overlay.id = "__demoo_grid";
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999";
      // Draw crosshairs and coordinate labels every 200px
      for (let x = 200; x < vp.width; x += 200) {
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;left:${x}px;top:0;width:1px;height:100%;background:rgba(255,255,0,0.15)`;
        overlay.appendChild(line);
        const label = document.createElement("div");
        label.style.cssText = `position:absolute;left:${x + 2}px;top:2px;font-size:10px;color:rgba(255,255,0,0.5);font-family:monospace`;
        label.textContent = String(x);
        overlay.appendChild(label);
      }
      for (let y = 200; y < vp.height; y += 200) {
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;top:${y}px;left:0;width:100%;height:1px;background:rgba(255,255,0,0.15)`;
        overlay.appendChild(line);
        const label = document.createElement("div");
        label.style.cssText = `position:absolute;top:${y + 2}px;left:2px;font-size:10px;color:rgba(255,255,0,0.5);font-family:monospace`;
        label.textContent = String(y);
        overlay.appendChild(label);
      }
      document.body.appendChild(overlay);
    }, viewport);

    await page.screenshot({ path: screenshotPath });
    screenshotBase64 = readFileSync(screenshotPath).toString("base64");

    // Remove grid overlay
    await page.evaluate(() => {
      document.getElementById("__demoo_grid")?.remove();
    });
  } else {
    screenshotBase64 = readFileSync(screenshotPath).toString("base64");
  }

  return {
    url,
    title,
    viewport,
    elements,
    semantic,
    screenshotPath,
    screenshotBase64,
  };
}

interface RawPageData {
  elements: PageElement[];
  semantic: SemanticSnapshot;
}

async function extractPageData(page: Page): Promise<RawPageData> {
  return page.evaluate(() => {
    // --- Extract interactive elements ---
    const interactiveSelectors = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='combobox']",
      "[role='textbox']",
      "[role='searchbox']",
      "[contenteditable='true']",
      "summary",
    ];

    const seen = new Set<Element>();
    const elements: PageElement[] = [];

    for (const sel of interactiveSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const computedStyle = window.getComputedStyle(el);
        const visible =
          computedStyle.display !== "none" &&
          computedStyle.visibility !== "hidden" &&
          computedStyle.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0;

        if (!visible) continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || undefined;
        const ariaLabel = el.getAttribute("aria-label") || undefined;
        const text =
          (el.textContent || "").trim().slice(0, 80) || undefined;
        const href =
          el instanceof HTMLAnchorElement ? el.href : undefined;
        const type =
          el instanceof HTMLInputElement ? el.type : undefined;
        const placeholder =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
            ? el.placeholder || undefined
            : undefined;
        const name =
          ariaLabel ||
          el.getAttribute("title") ||
          (el as HTMLInputElement).name ||
          undefined;
        const value =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
            ? el.value || undefined
            : undefined;

        const selector = generateSelector(el);
        const enabled = !(el as HTMLInputElement).disabled;

        elements.push({
          tag,
          role,
          name,
          text,
          href,
          type,
          placeholder,
          selector,
          visible,
          enabled,
          value,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    }

    // --- Build semantic snapshot ---

    // Navigation: links inside nav elements
    const navLinks: string[] = [];
    for (const nav of document.querySelectorAll("nav, [role='navigation']")) {
      for (const a of nav.querySelectorAll("a")) {
        const t = (a.textContent || "").trim();
        if (t) navLinks.push(t);
      }
    }

    // Headings
    const headings: string[] = [];
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      const t = (h.textContent || "").trim().slice(0, 60);
      if (t) headings.push(`${h.tagName.toLowerCase()}: ${t}`);
    }

    // Forms — group inputs with their labels
    const forms: SemanticSnapshot["forms"] = [];
    for (const form of document.querySelectorAll("form, [role='form']")) {
      const fields: { label: string; type: string; value: string; selector: string }[] = [];
      for (const input of form.querySelectorAll("input, textarea, select")) {
        const inp = input as HTMLInputElement;
        const label =
          inp.getAttribute("aria-label") ||
          inp.placeholder ||
          inp.name ||
          inp.type ||
          "unknown";
        fields.push({
          label,
          type: inp.type || inp.tagName.toLowerCase(),
          value: inp.value || "",
          selector: generateSelector(inp),
        });
      }
      const buttons: string[] = [];
      for (const btn of form.querySelectorAll("button, input[type='submit']")) {
        buttons.push((btn.textContent || "").trim() || "Submit");
      }
      if (fields.length > 0) {
        const formName =
          form.getAttribute("aria-label") ||
          form.getAttribute("name") ||
          "Form";
        forms.push({ name: formName, fields, buttons });
      }
    }

    // Standalone buttons (not in forms)
    const formElements = new Set<Element>();
    for (const form of document.querySelectorAll("form, [role='form']")) {
      for (const el of form.querySelectorAll("*")) formElements.add(el);
    }
    const buttons: { text: string; selector: string }[] = [];
    for (const btn of document.querySelectorAll("button, [role='button']")) {
      if (formElements.has(btn)) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const t = (btn.textContent || "").trim().slice(0, 40);
      if (t) buttons.push({ text: t, selector: generateSelector(btn) });
    }

    // Standalone links (not in nav)
    const navElements = new Set<Element>();
    for (const nav of document.querySelectorAll("nav, [role='navigation']")) {
      for (const el of nav.querySelectorAll("*")) navElements.add(el);
    }
    const links: { text: string; href: string; selector: string }[] = [];
    for (const a of document.querySelectorAll("a[href]")) {
      if (navElements.has(a)) continue;
      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const t = (a.textContent || "").trim().slice(0, 40);
      if (t)
        links.push({
          text: t,
          href: (a as HTMLAnchorElement).href,
          selector: generateSelector(a),
        });
    }

    // Canvas/SVG regions (for coordinate-based interaction)
    const canvasRegions: { x: number; y: number; width: number; height: number }[] = [];
    for (const el of document.querySelectorAll("canvas, svg")) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 50) {
        canvasRegions.push({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    // Brief text summary — first meaningful paragraph
    let textSummary = "";
    for (const p of document.querySelectorAll("p, [role='main'] > div")) {
      const t = (p.textContent || "").trim();
      if (t.length > 20) {
        textSummary = t.slice(0, 150);
        break;
      }
    }

    const semantic: SemanticSnapshot = {
      navigation: navLinks.slice(0, 10),
      forms,
      headings: headings.slice(0, 8),
      buttons: buttons.slice(0, 15),
      links: links.slice(0, 15),
      canvasRegions,
      textSummary,
    };

    return { elements: elements.slice(0, 50), semantic };

    function generateSelector(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute("data-testid");
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
      const elName = el.getAttribute("name");
      if (elName) return `${el.tagName.toLowerCase()}[name="${CSS.escape(elName)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === el.tagName,
        );
        if (siblings.length === 1) return el.tagName.toLowerCase();
        const index = siblings.indexOf(el) + 1;
        return `${el.tagName.toLowerCase()}:nth-of-type(${index})`;
      }
      return el.tagName.toLowerCase();
    }
  });
}
