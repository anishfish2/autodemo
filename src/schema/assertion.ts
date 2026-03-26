import { z } from "zod";
import { Target } from "./target.js";

export const UrlAssertion = z.object({
  type: z.literal("url"),
  operator: z.enum(["equals", "contains", "matches"]),
  value: z.string(),
});

export const ElementVisibleAssertion = z.object({
  type: z.literal("element_visible"),
  target: Target,
});

export const ElementHiddenAssertion = z.object({
  type: z.literal("element_hidden"),
  target: Target,
});

export const TextContentAssertion = z.object({
  type: z.literal("text_content"),
  target: Target,
  operator: z.enum(["equals", "contains", "matches"]),
  value: z.string(),
});

export const ElementCountAssertion = z.object({
  type: z.literal("element_count"),
  target: Target,
  operator: z.enum(["eq", "gt", "gte", "lt", "lte"]),
  value: z.number().int().nonnegative(),
});

export const TitleAssertion = z.object({
  type: z.literal("title"),
  operator: z.enum(["equals", "contains", "matches"]),
  value: z.string(),
});

export const Assertion = z.discriminatedUnion("type", [
  UrlAssertion,
  ElementVisibleAssertion,
  ElementHiddenAssertion,
  TextContentAssertion,
  ElementCountAssertion,
  TitleAssertion,
]);

export type Assertion = z.infer<typeof Assertion>;
