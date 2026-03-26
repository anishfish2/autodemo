import { z } from "zod";
import { Target } from "./target.js";
import { Assertion } from "./assertion.js";

const StepBase = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  timeout_ms: z.number().int().positive().default(10000),
  retry: z
    .object({
      max_attempts: z.number().int().min(1).max(10).default(1),
      delay_ms: z.number().int().nonnegative().default(500),
    })
    .default({}),
  assertions: z.array(Assertion).default([]),
  screenshot: z.enum(["before", "after", "both", "none"]).default("after"),
});

export const OpenAppAction = StepBase.extend({
  action: z.literal("open_app"),
  app_name: z.string().min(1),
});

export const FocusAppAction = StepBase.extend({
  action: z.literal("focus_app"),
  app_name: z.string().min(1),
});

export const OpenUrlAction = StepBase.extend({
  action: z.literal("open_url"),
  url: z.string().url(),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .default("load"),
});

export const ClickAction = StepBase.extend({
  action: z.literal("click"),
  target: Target,
  button: z.enum(["left", "right", "middle"]).default("left"),
  click_count: z.number().int().min(1).max(3).default(1),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .default([]),
});

export const TypeAction = StepBase.extend({
  action: z.literal("type"),
  target: Target,
  text: z.string(),
  clear_first: z.boolean().default(false),
  delay_ms: z.number().int().nonnegative().default(0),
});

export const PressKeysAction = StepBase.extend({
  action: z.literal("press_keys"),
  keys: z.string().min(1),
  target: Target.optional(),
});

export const WaitForAction = StepBase.extend({
  action: z.literal("wait_for"),
  condition: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("selector"),
      target: Target,
      state: z
        .enum(["visible", "hidden", "attached", "detached"])
        .default("visible"),
    }),
    z.object({
      type: z.literal("url"),
      value: z.string(),
      operator: z.enum(["equals", "contains", "matches"]).default("contains"),
    }),
    z.object({
      type: z.literal("delay_ms"),
      value: z.number().int().positive(),
    }),
    z.object({
      type: z.literal("navigation"),
    }),
  ]),
});

export const ScrollAction = StepBase.extend({
  action: z.literal("scroll"),
  target: Target.optional(),
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().int().positive().default(300),
});

export const UploadFileAction = StepBase.extend({
  action: z.literal("upload_file"),
  target: Target,
  file_path: z.string().min(1),
});

export const ExtractTextAction = StepBase.extend({
  action: z.literal("extract_text"),
  target: Target,
  store_as: z.string().min(1),
});

export const AssertAction = StepBase.extend({
  action: z.literal("assert"),
  assertion: Assertion,
  message: z.string().optional(),
});

export const DoneAction = StepBase.extend({
  action: z.literal("done"),
  message: z.string().optional(),
});

// --- Director Actions (camera & animation control) ---

export const ZoomToAction = StepBase.extend({
  action: z.literal("zoom_to"),
  target: Target,
  zoom_level: z.number().min(1).max(10).default(2),
  duration_ms: z.number().int().positive().default(500),
});

export const ZoomOutAction = StepBase.extend({
  action: z.literal("zoom_out"),
  duration_ms: z.number().int().positive().default(500),
});

export const HighlightAction = StepBase.extend({
  action: z.literal("highlight"),
  target: Target,
  style: z.enum(["glow", "box", "arrow"]).default("box"),
  color: z.string().default("#FF0000"),
  duration_ms: z.number().int().positive().default(2000),
});

export const CalloutAction = StepBase.extend({
  action: z.literal("callout"),
  target: Target,
  text: z.string().min(1),
  position: z.enum(["top", "bottom", "left", "right"]).default("top"),
  duration_ms: z.number().int().positive().default(3000),
});

export const PauseAction = StepBase.extend({
  action: z.literal("pause"),
  duration_ms: z.number().int().positive().default(1500),
});

export const TransitionAction = StepBase.extend({
  action: z.literal("transition"),
  style: z.enum(["fade", "wipe", "none"]).default("fade"),
  duration_ms: z.number().int().positive().default(800),
});

export const SetSpeedAction = StepBase.extend({
  action: z.literal("set_speed"),
  speed: z.number().min(0.25).max(8).default(1),
});

export const Action = z.discriminatedUnion("action", [
  OpenAppAction,
  FocusAppAction,
  OpenUrlAction,
  ClickAction,
  TypeAction,
  PressKeysAction,
  WaitForAction,
  ScrollAction,
  UploadFileAction,
  ExtractTextAction,
  AssertAction,
  DoneAction,
  ZoomToAction,
  ZoomOutAction,
  HighlightAction,
  CalloutAction,
  PauseAction,
  TransitionAction,
  SetSpeedAction,
]);

export type Action = z.infer<typeof Action>;
export type ActionType = Action["action"];
