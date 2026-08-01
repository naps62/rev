/**
 * REST routes per the contract at the bottom of shared/types.ts.
 * Pure HTTP glue: validation + composition of git/db/discovery. Every dir
 * param must pass discovery.isKnownRepo before any git call — the server
 * runs unauthenticated on the LAN and must not run git against arbitrary
 * attacker-supplied paths outside real checkouts.
 */

import { Hono } from "hono";

/** Build the /api sub-app. `broadcast` sends a ServerMessage to all WS clients. */
export function buildApi(broadcast: (msg: import("@shared/types").ServerMessage) => void): Hono {
  throw new Error("not implemented");
}
