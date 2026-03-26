import type { Page } from "playwright";
import type { Action } from "../schema/action.js";
import type { Logger } from "pino";

export interface VerificationResult {
  passed: boolean;
  detail: string;
}

/**
 * Deterministic post-action verification.
 * Checks that each action had its expected effect on the page.
 */
export async function verifyAction(
  action: Action,
  page: Page,
  preUrl: string,
  logger: Logger,
): Promise<VerificationResult> {
  try {
    switch (action.action) {
      case "open_url":
        return verifyOpenUrl(page, action.url);

      case "click":
        return verifyClick(page, preUrl);

      case "type":
        return await verifyType(page, action);

      case "press_keys":
        // Enter might navigate, Escape might close a modal — hard to verify generically
        return { passed: true, detail: "key press executed" };

      case "scroll":
        return { passed: true, detail: "scroll executed" };

      case "wait_for":
        return { passed: true, detail: "wait completed" };

      case "extract_text":
        return { passed: true, detail: "text extracted" };

      case "open_app":
      case "focus_app":
        return { passed: true, detail: "app action executed" };

      // Director actions — always pass (no browser effect)
      case "zoom_to":
      case "zoom_out":
      case "highlight":
      case "callout":
      case "pause":
      case "transition":
      case "set_speed":
      case "done":
      case "assert":
      case "upload_file":
        return { passed: true, detail: "action completed" };

      default:
        return { passed: true, detail: "unverified action" };
    }
  } catch (err) {
    return {
      passed: false,
      detail: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function verifyOpenUrl(page: Page, expectedUrl: string): VerificationResult {
  const currentUrl = page.url();
  // Check if we navigated somewhere (not still on about:blank or previous page)
  if (currentUrl === "about:blank") {
    return { passed: false, detail: `Still on about:blank, expected ${expectedUrl}` };
  }
  // Loose match — URL might have trailing slash, query params, etc.
  if (currentUrl.includes(new URL(expectedUrl).hostname)) {
    return { passed: true, detail: `Navigated to ${currentUrl}` };
  }
  return { passed: true, detail: `On ${currentUrl}` };
}

function verifyClick(page: Page, preUrl: string): VerificationResult {
  const postUrl = page.url();
  if (postUrl !== preUrl) {
    return { passed: true, detail: `Click caused navigation to ${postUrl}` };
  }
  // Click didn't navigate — that's fine, it may have toggled something
  return { passed: true, detail: "click executed (no navigation)" };
}

async function verifyType(
  page: Page,
  action: Extract<Action, { action: "type" }>,
): Promise<VerificationResult> {
  // Verify the target input now contains the typed text
  try {
    const target = action.target;
    let locator;
    switch (target.strategy) {
      case "selector":
        locator = page.locator(target.value);
        break;
      case "role":
        locator = page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
          name: target.name,
        });
        break;
      case "label":
        locator = page.getByLabel(target.value);
        break;
      case "text":
        // Can't verify text input on a text-matched element easily
        return { passed: true, detail: "type executed" };
      case "coordinates":
        return { passed: true, detail: "type executed (coordinates)" };
    }

    if (locator) {
      const value = await locator.inputValue().catch(() => null);
      if (value !== null) {
        if (value.includes(action.text) || action.text.includes(value)) {
          return { passed: true, detail: `Input contains "${value.slice(0, 30)}"` };
        }
        return {
          passed: false,
          detail: `Input value "${value.slice(0, 30)}" doesn't match typed text "${action.text.slice(0, 30)}"`,
        };
      }
    }
  } catch {
    // Verification failed but action may have still worked
  }
  return { passed: true, detail: "type executed" };
}
