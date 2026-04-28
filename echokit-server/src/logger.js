/**
 * Logger — structured JSON logs.
 *
 * In production: plain JSON to stdout (Railway will parse and display).
 * In development: pino-pretty for readable colored output.
 *
 * Every log line includes a `service` field for later when multiple services
 * share a log drain (Axiom, Papertrail, etc.).
 */

import pino from "pino";
import { config } from "./config.js";

const isDev = config.NODE_ENV === "development";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: "echokit-server",
    env: config.NODE_ENV,
  },
  // Pretty-print in dev only.
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service,env",
        },
      }
    : undefined,
});

/** Scoped logger for a specific call. Every line will include `call_uuid`. */
export function forCall(callUuid) {
  return logger.child({ call_uuid: callUuid });
}
