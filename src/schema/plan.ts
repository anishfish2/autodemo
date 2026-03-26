import { z } from "zod";
import { Action } from "./action.js";

export const PlanMetadata = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().default("1"),
  tags: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().default(120000),
  screen: z
    .object({
      width: z.number().int().positive().default(1920),
      height: z.number().int().positive().default(1080),
    })
    .default({}),
});

export const Plan = z.object({
  metadata: PlanMetadata,
  steps: z.array(Action).min(1),
});

export type Plan = z.infer<typeof Plan>;
export type PlanMetadata = z.infer<typeof PlanMetadata>;
