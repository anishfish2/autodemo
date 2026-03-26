import type { Page } from "playwright";
import type { Assertion } from "../schema/assertion.js";
import type { TargetResolver } from "../target/target-resolver.js";

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  actual?: string;
  expected?: string;
  message: string;
}

export class AssertionEngine {
  constructor(private targetResolver: TargetResolver) {}

  async evaluate(assertion: Assertion, page: Page): Promise<AssertionResult> {
    switch (assertion.type) {
      case "url":
        return this.evaluateUrl(assertion, page);
      case "title":
        return this.evaluateTitle(assertion, page);
      case "element_visible":
        return this.evaluateElementVisible(assertion, page);
      case "element_hidden":
        return this.evaluateElementHidden(assertion, page);
      case "text_content":
        return this.evaluateTextContent(assertion, page);
      case "element_count":
        return this.evaluateElementCount(assertion, page);
    }
  }

  async evaluateAll(
    assertions: Assertion[],
    page: Page,
  ): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];
    for (const assertion of assertions) {
      results.push(await this.evaluate(assertion, page));
    }
    return results;
  }

  private matchOperator(
    actual: string,
    operator: "equals" | "contains" | "matches",
    expected: string,
  ): boolean {
    switch (operator) {
      case "equals":
        return actual === expected;
      case "contains":
        return actual.includes(expected);
      case "matches":
        return new RegExp(expected).test(actual);
    }
  }

  private async evaluateUrl(
    assertion: Extract<Assertion, { type: "url" }>,
    page: Page,
  ): Promise<AssertionResult> {
    const actual = page.url();
    const passed = this.matchOperator(actual, assertion.operator, assertion.value);
    return {
      assertion,
      passed,
      actual,
      expected: assertion.value,
      message: passed
        ? `url ${assertion.operator} "${assertion.value}"`
        : `url ${assertion.operator} "${assertion.value}" — got "${actual}"`,
    };
  }

  private async evaluateTitle(
    assertion: Extract<Assertion, { type: "title" }>,
    page: Page,
  ): Promise<AssertionResult> {
    const actual = await page.title();
    const passed = this.matchOperator(actual, assertion.operator, assertion.value);
    return {
      assertion,
      passed,
      actual,
      expected: assertion.value,
      message: passed
        ? `title ${assertion.operator} "${assertion.value}"`
        : `title ${assertion.operator} "${assertion.value}" — got "${actual}"`,
    };
  }

  private async evaluateElementVisible(
    assertion: Extract<Assertion, { type: "element_visible" }>,
    page: Page,
  ): Promise<AssertionResult> {
    try {
      const resolved = this.targetResolver.resolve(assertion.target, page);
      if (resolved.kind === "locator") {
        const visible = await resolved.locator.isVisible();
        return {
          assertion,
          passed: visible,
          message: visible
            ? "element is visible"
            : "element is NOT visible (expected visible)",
        };
      }
      return {
        assertion,
        passed: false,
        message: "Cannot check visibility for coordinate targets",
      };
    } catch (err) {
      return {
        assertion,
        passed: false,
        message: `element_visible check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async evaluateElementHidden(
    assertion: Extract<Assertion, { type: "element_hidden" }>,
    page: Page,
  ): Promise<AssertionResult> {
    try {
      const resolved = this.targetResolver.resolve(assertion.target, page);
      if (resolved.kind === "locator") {
        const visible = await resolved.locator.isVisible();
        return {
          assertion,
          passed: !visible,
          message: !visible
            ? "element is hidden"
            : "element is VISIBLE (expected hidden)",
        };
      }
      return {
        assertion,
        passed: false,
        message: "Cannot check visibility for coordinate targets",
      };
    } catch (err) {
      // If element not found at all, it counts as hidden
      return {
        assertion,
        passed: true,
        message: "element not found (counts as hidden)",
      };
    }
  }

  private async evaluateTextContent(
    assertion: Extract<Assertion, { type: "text_content" }>,
    page: Page,
  ): Promise<AssertionResult> {
    try {
      const resolved = this.targetResolver.resolve(assertion.target, page);
      if (resolved.kind !== "locator") {
        return {
          assertion,
          passed: false,
          message: "Cannot check text content for coordinate targets",
        };
      }
      const actual = (await resolved.locator.textContent()) ?? "";
      const passed = this.matchOperator(actual, assertion.operator, assertion.value);
      return {
        assertion,
        passed,
        actual,
        expected: assertion.value,
        message: passed
          ? `text_content ${assertion.operator} "${assertion.value}"`
          : `text_content ${assertion.operator} "${assertion.value}" — got "${actual}"`,
      };
    } catch (err) {
      return {
        assertion,
        passed: false,
        message: `text_content check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async evaluateElementCount(
    assertion: Extract<Assertion, { type: "element_count" }>,
    page: Page,
  ): Promise<AssertionResult> {
    try {
      const resolved = this.targetResolver.resolve(assertion.target, page);
      if (resolved.kind !== "locator") {
        return {
          assertion,
          passed: false,
          message: "Cannot count coordinate targets",
        };
      }
      const count = await resolved.locator.count();
      let passed = false;
      switch (assertion.operator) {
        case "eq":
          passed = count === assertion.value;
          break;
        case "gt":
          passed = count > assertion.value;
          break;
        case "gte":
          passed = count >= assertion.value;
          break;
        case "lt":
          passed = count < assertion.value;
          break;
        case "lte":
          passed = count <= assertion.value;
          break;
      }
      return {
        assertion,
        passed,
        actual: String(count),
        expected: `${assertion.operator} ${assertion.value}`,
        message: passed
          ? `element_count ${assertion.operator} ${assertion.value} (got ${count})`
          : `element_count ${assertion.operator} ${assertion.value} — got ${count}`,
      };
    } catch (err) {
      return {
        assertion,
        passed: false,
        message: `element_count check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
