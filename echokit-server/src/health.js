/**
 * Health check — used by Railway's built-in health checker and uptime probes.
 *
 * Returns 200 as long as the process is running and able to respond to HTTP.
 * As more dependencies are added (Redis, Postgres, agent-api), this will
 * become a deeper check that pings each.
 */

import { Router } from "express";
import { config, signatureEnabled } from "./config.js";

const STARTED_AT = Date.now();

export function createHealthRouter() {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "echokit-server",
      env: config.NODE_ENV,
      uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
      signature_verification: signatureEnabled() ? "enabled" : "disabled",
    });
  });

  // A friendly root page for humans who paste the URL into a browser.
  // Not part of any contract — purely for debugging / sanity checks.
  router.get("/", (_req, res) => {
    res.type("text/plain").send(
      [
        "echokit-server is running.",
        "",
        "Endpoints:",
        "  GET  /healthz              — liveness probe",
        "  POST /webhooks/answer      — Vonage call-answer webhook",
        "  POST /webhooks/events      — Vonage call-state events",
        "  POST /webhooks/fallback    — Vonage error fallback",
        "  WS   /ws/voice             — Vonage bidirectional audio stream",
        "",
        `Version: 0.1.0 (slice 1)`,
        `Env: ${config.NODE_ENV}`,
        `Signature verification: ${signatureEnabled() ? "enabled" : "disabled"}`,
      ].join("\n")
    );
  });

  return router;
}
