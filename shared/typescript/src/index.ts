/**
 * @voiceai/contracts
 *
 * Shared TypeScript types and Zod schemas for Car Dealership Voice AI.
 * Mirrors ../contracts/*.schema.json — the canonical JSON Schemas.
 *
 * When a schema changes, update both this package and the Pydantic package
 * (../python/), then run ../scripts/verify-contracts.mjs.
 */

export * from "./session.js";
export * from "./vehicle.js";
export * from "./agent-turn.js";
export * from "./events.js";
