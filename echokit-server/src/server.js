/**
 * echokit-server — main entry point.
 *
 * Starts an HTTP server with:
 *   - Express routes for Vonage webhooks
 *   - A /healthz route for Railway
 *   - A WebSocket server on /ws/voice for Vonage audio streaming
 *
 * Graceful shutdown on SIGTERM/SIGINT — Railway sends SIGTERM on redeploys
 * and gives ~30s for in-flight requests to finish before force-killing.
 */

import { createServer } from "node:http";
import express from "express";
import { config, getWebSocketUrl, signatureEnabled } from "./config.js";
import { logger } from "./logger.js";
import { createWebhookRouter } from "./webhooks.js";
import { createHealthRouter } from "./health.js";
import { attachWebSocketServer } from "./websocket.js";
import { attachSupervisorSocket } from "./supervisor.js";

function main() {
  const app = express();

  // Capture the raw request body so the signature verifier can hash it.
  // Without this, express.json() discards the original bytes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
      limit: "100kb",
    })
  );
  app.use(
    express.urlencoded({
      extended: true,
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
      limit: "100kb",
    })
  );

  // Routes
  app.use(createHealthRouter());
  app.use(createWebhookRouter());

  // 404 handler
  app.use((req, res) => {
    logger.warn({ method: req.method, path: req.path }, "404 Not Found");
    res.status(404).json({ error: "not_found" });
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error(
      { err: err.message, stack: err.stack, path: req.path },
      "Unhandled request error"
    );
    res.status(500).json({ error: "internal_server_error" });
  });

  const httpServer = createServer(app);
  const wss = attachWebSocketServer(httpServer);
  const supervisorIo = attachSupervisorSocket(httpServer);

  httpServer.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        publicUrl: config.PUBLIC_URL,
        wsUrl: getWebSocketUrl(),
        signatureVerification: signatureEnabled() ? "enabled" : "disabled",
        env: config.NODE_ENV,
      },
      "echokit-server listening"
    );
  });

  // ─── Graceful shutdown ───
  // Close the HTTP server first (stops accepting new connections), then
  // close all WS connections, then exit.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down…");

    // Close active WebSocket sessions with status 1001 (going away).
    for (const client of wss.clients) {
      try {
        client.close(1001, "server_shutdown");
      } catch {
        /* ignore */
      }
    }

    httpServer.close((err) => {
      if (err) logger.error({ err: err.message }, "Error closing HTTP server");
      logger.info("HTTP server closed");
      process.exit(0);
    });

    // Force-exit if clean close doesn't complete in 15s.
    setTimeout(() => {
      logger.warn("Forcing exit after 15s grace period");
      process.exit(1);
    }, 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Surface uncaught errors — these usually mean a bug, not a runtime condition.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception");
    process.exit(1);
  });
}

main();
