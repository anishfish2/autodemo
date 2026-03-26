import type { Page, Locator } from "playwright";
import type { Target } from "../schema/target.js";

export type ResolvedTarget =
  | { kind: "locator"; locator: Locator }
  | { kind: "coordinates"; x: number; y: number };

export class TargetResolver {
  resolve(target: Target, page: Page): ResolvedTarget {
    switch (target.strategy) {
      case "selector": {
        const base = target.iframe
          ? page.frameLocator(target.iframe)
          : page;
        return { kind: "locator", locator: base.locator(target.value) };
      }
      case "role":
        return {
          kind: "locator",
          locator: page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
            name: target.name,
          }),
        };
      case "label":
        return {
          kind: "locator",
          locator: page.getByLabel(target.value),
        };
      case "text":
        return {
          kind: "locator",
          locator: page.getByText(target.value, { exact: target.exact }),
        };
      case "coordinates":
        return { kind: "coordinates", x: target.x, y: target.y };
    }
  }

  async waitForTarget(
    target: Target,
    page: Page,
    timeout_ms: number,
  ): Promise<ResolvedTarget> {
    const resolved = this.resolve(target, page);
    if (resolved.kind === "locator") {
      await resolved.locator.waitFor({ state: "visible", timeout: timeout_ms });
    }
    return resolved;
  }
}
