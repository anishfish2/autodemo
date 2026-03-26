import pino from "pino";
import type { Logger } from "pino";
import { join } from "node:path";

export function createLogger(runDir: string, verbose: boolean): Logger {
  const targets: pino.TransportTargetOptions[] = [
    // Pretty console output
    {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
      level: verbose ? "debug" : "info",
    },
    // JSON file for machine consumption
    {
      target: "pino/file",
      options: { destination: join(runDir, "run.log"), mkdir: true },
      level: "debug",
    },
  ];

  return pino(
    { level: "debug" },
    pino.transport({ targets }),
  );
}
