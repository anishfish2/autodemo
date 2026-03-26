import { ZodError } from "zod";
import { Plan } from "../schema/plan.js";
import type { Plan as PlanType } from "../schema/plan.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  plan?: PlanType;
  errors: ValidationError[];
  warnings: string[];
}

function formatZodErrors(error: ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

export function validatePlan(raw: unknown): ValidationResult {
  const warnings: string[] = [];

  // 1. Zod parse (applies defaults)
  const result = Plan.safeParse(raw);

  if (!result.success) {
    return {
      valid: false,
      errors: formatZodErrors(result.error),
      warnings,
    };
  }

  const plan = result.data;

  // 2. Auto-generate step IDs where missing
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.id) {
      (step as { id?: string }).id = `step_${i}_${step.action}`;
    }
  }

  // 3. Semantic checks

  // Check for duplicate extract_text store_as names
  const storeNames = new Set<string>();
  for (const step of plan.steps) {
    if (step.action === "extract_text") {
      if (storeNames.has(step.store_as)) {
        warnings.push(
          `Duplicate store_as name "${step.store_as}" — later extract_text will overwrite earlier value`,
        );
      }
      storeNames.add(step.store_as);
    }
  }

  // Warn if last step is not done
  const lastStep = plan.steps[plan.steps.length - 1];
  if (lastStep.action !== "done") {
    warnings.push(
      'Last step is not "done" — consider adding a done step for clarity',
    );
  }

  return {
    valid: true,
    plan,
    errors: [],
    warnings,
  };
}
