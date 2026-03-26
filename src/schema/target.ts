import { z } from "zod";

export const CssSelectorTarget = z.object({
  strategy: z.literal("selector"),
  value: z.string().min(1),
  iframe: z.string().optional(),
});

export const RoleTarget = z.object({
  strategy: z.literal("role"),
  role: z.string().min(1),
  name: z.string().optional(),
});

export const LabelTarget = z.object({
  strategy: z.literal("label"),
  value: z.string().min(1),
});

export const TextTarget = z.object({
  strategy: z.literal("text"),
  value: z.string().min(1),
  exact: z.boolean().default(false),
});

export const CoordinateTarget = z.object({
  strategy: z.literal("coordinates"),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const Target = z.discriminatedUnion("strategy", [
  CssSelectorTarget,
  RoleTarget,
  LabelTarget,
  TextTarget,
  CoordinateTarget,
]);

export type Target = z.infer<typeof Target>;
