export type RecordingEventType =
  | "cursor"
  | "click"
  | "scenario_start"
  | "scenario_end"
  | "zoom_to"
  | "zoom_out"
  | "highlight"
  | "callout"
  | "pause"
  | "transition"
  | "set_speed";

export interface RecordingEvent {
  type: RecordingEventType;
  timestamp: number; // ms since recording start
  x?: number;
  y?: number;
  button?: string;
  title?: string;
  // Director action fields
  zoom_level?: number;
  duration_ms?: number;
  width?: number;
  height?: number;
  style?: string;
  color?: string;
  text?: string;
  position?: string;
  speed?: number;
}

export interface DirectorEventData {
  type: RecordingEventType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zoom_level?: number;
  duration_ms?: number;
  style?: string;
  color?: string;
  text?: string;
  position?: string;
  speed?: number;
}

export interface RecordingOptions {
  enabled: boolean;
  raw?: boolean;
  zoomLevel?: number;
  fps?: number;
  output?: string;
}

export interface ProcessingOptions {
  inputVideo: string;
  eventsLog: string;
  outputVideo: string;
  zoomLevel: number;
  fps: number;
  resolution: { w: number; h: number };
}
