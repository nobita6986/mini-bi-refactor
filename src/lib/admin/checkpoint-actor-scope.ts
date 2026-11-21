/**
 * Server-side opaque actor scope helper for WP13 Checkpoint V2.
 *
 * Isolates browser sessionStorage checkpoints by real actor identity
 * (`app_user_id`) using a one-way SHA-256 digest so two Full Admins sharing
 * the exact same role can never see or replay each other's checkpoints, while
 * never exposing raw `app_user_id`, `auth_subject`, email, or role labels
 * into browser storage.
 */
import "server-only";
import { createHash } from "node:crypto";

const CHECKPOINT_ACTOR_SCOPE_PREFIX = "wp13-cp-v2:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function computeCheckpointActorScope(appUserId: string): string {
  const normalized = typeof appUserId === "string" ? appUserId.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("checkpointActorScope requires a valid UUID app_user_id");
  }
  const digest = createHash("sha256")
    .update(`${CHECKPOINT_ACTOR_SCOPE_PREFIX}${normalized}`)
    .digest("hex")
    .slice(0, 24);
  return `act_${digest}`;
}
