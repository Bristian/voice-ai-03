/**
 * Vonage webhook signature verification.
 *
 * Vonage signs webhooks with an HS256 JWT in the Authorization header:
 *   Authorization: Bearer <jwt>
 *
 * The signature secret shown in the Vonage dashboard is base64-encoded. We
 * have to Buffer.from(secret, 'base64') before passing it to jsonwebtoken,
 * otherwise verification will silently fail. (This has tripped up many teams.)
 *
 * The JWT payload contains a `payload_hash` claim — a SHA-256 hex digest of
 * the raw request body. Comparing this to our own hash of the raw body
 * detects payload tampering.
 *
 * This middleware is a no-op unless VONAGE_SIGNATURE_SECRET is set. This
 * keeps slice 1 working out of the box (Vonage trials don't force signing),
 * and you can enable verification later via the dashboard + env var.
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config, signatureEnabled } from "./config.js";
import { logger } from "./logger.js";

/**
 * Express middleware factory. Returns a middleware that rejects with 401 if
 * the Vonage signature is invalid. Passes through untouched if signing is
 * disabled at the config level.
 *
 * IMPORTANT: requires express.raw() or express.json({verify}) to have captured
 * the raw body into req.rawBody.
 */
export function vonageSignatureMiddleware() {
  if (!signatureEnabled()) {
    logger.warn(
      "Vonage signature verification is DISABLED (VONAGE_SIGNATURE_SECRET empty). Enable for production."
    );
    return (_req, _res, next) => next();
  }

  const secretBytes = Buffer.from(config.VONAGE_SIGNATURE_SECRET, "base64");

  return function verifySignature(req, res, next) {
    const authHeader = req.get("Authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      logger.warn({ path: req.path }, "Missing Bearer token on signed webhook");
      return res.status(401).json({ error: "missing_signature" });
    }
    const token = match[1];

    let decoded;
    try {
      decoded = jwt.verify(token, secretBytes, { algorithms: ["HS256"] });
    } catch (err) {
      logger.warn({ err: err.message }, "JWT verification failed");
      return res.status(401).json({ error: "invalid_signature" });
    }

    // Optional payload-hash check (defends against body tampering in transit).
    if (decoded && typeof decoded === "object" && decoded.payload_hash) {
      const raw = req.rawBody ?? Buffer.alloc(0);
      const computed = crypto.createHash("sha256").update(raw).digest("hex");
      let expected;
      try {
        expected = Buffer.from(decoded.payload_hash, "hex");
      } catch {
        logger.warn("payload_hash claim is not valid hex");
        return res.status(401).json({ error: "invalid_payload_hash" });
      }
      const computedBuf = Buffer.from(computed, "hex");
      if (
        computedBuf.length !== expected.length ||
        !crypto.timingSafeEqual(computedBuf, expected)
      ) {
        logger.warn("Payload hash mismatch — request body may have been tampered");
        return res.status(401).json({ error: "payload_tampered" });
      }
    }

    next();
  };
}
