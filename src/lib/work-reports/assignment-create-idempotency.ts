export type AssignmentCreateTargetKind = "USER" | "TEAM" | "USER_SET" | "GROUP";

export type AssignmentCreateFormInput = {
  template_id: string;
  target_kind: AssignmentCreateTargetKind;
  target_user_id: string | null;
  target_team_id: string | null;
  target_group_id: string | null;
  target_user_ids: readonly string[];
  frequency: string;
  is_mandatory: boolean;
  due_day_offset: number;
  due_time_local: string;
  exclude_sundays: boolean;
};

export type AssignmentCreateRequestPayload = Omit<AssignmentCreateFormInput, "target_user_ids"> & {
  target_user_ids: string[];
  idempotency_key: string;
};

export type PendingAssignmentCreateAttempt = {
  fingerprint: string;
  idempotency_key: string;
  payload: AssignmentCreateRequestPayload;
};

export function createAssignmentIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function assignmentCreateInputFingerprint(input: AssignmentCreateFormInput): string {
  return JSON.stringify([
    input.template_id,
    input.target_kind,
    input.target_user_id,
    input.target_team_id,
    input.target_group_id,
    input.target_user_ids,
    input.frequency,
    input.is_mandatory,
    input.due_day_offset,
    input.due_time_local,
    input.exclude_sundays,
  ]);
}

/**
 * Reuses the exact pending `(idempotency_key, payload)` across retries when form
 * inputs have not changed, so network/server failures never generate a second
 * `idempotency_key` (preventing duplicate `USER_SET` assignments or midnight drift).
 */
export function resolveAssignmentCreateAttempt(
  pending: PendingAssignmentCreateAttempt | null,
  input: AssignmentCreateFormInput,
  nextIdempotencyKey: () => string = createAssignmentIdempotencyKey,
): PendingAssignmentCreateAttempt {
  const fingerprint = assignmentCreateInputFingerprint(input);
  if (pending !== null && pending.fingerprint === fingerprint) {
    return pending;
  }
  const idempotency_key = nextIdempotencyKey();
  return {
    fingerprint,
    idempotency_key,
    payload: {
      template_id: input.template_id,
      target_kind: input.target_kind,
      target_user_id: input.target_user_id,
      target_team_id: input.target_team_id,
      target_group_id: input.target_group_id,
      target_user_ids: [...input.target_user_ids],
      frequency: input.frequency,
      is_mandatory: input.is_mandatory,
      due_day_offset: input.due_day_offset,
      due_time_local: input.due_time_local,
      exclude_sundays: input.exclude_sundays,
      idempotency_key,
    },
  };
}
