export class DemooError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly stepIndex?: number,
  ) {
    super(message);
    this.name = "DemooError";
  }
}

export class ElementNotFoundError extends DemooError {
  constructor(message: string, stepIndex?: number) {
    super(message, "ELEMENT_NOT_FOUND", stepIndex);
    this.name = "ElementNotFoundError";
  }
}

export class AssertionFailedError extends DemooError {
  constructor(message: string, stepIndex?: number) {
    super(message, "ASSERTION_FAILED", stepIndex);
    this.name = "AssertionFailedError";
  }
}

export class StepTimeoutError extends DemooError {
  constructor(message: string, stepIndex?: number) {
    super(message, "TIMEOUT", stepIndex);
    this.name = "StepTimeoutError";
  }
}

export class PlanValidationError extends DemooError {
  constructor(message: string) {
    super(message, "PLAN_VALIDATION_ERROR");
    this.name = "PlanValidationError";
  }
}

export class AppleScriptError extends DemooError {
  constructor(message: string, stepIndex?: number) {
    super(message, "APPLESCRIPT_ERROR", stepIndex);
    this.name = "AppleScriptError";
  }
}
