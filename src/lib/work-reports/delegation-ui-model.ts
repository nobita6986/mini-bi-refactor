export type DelegatedCapability = "report_assign" | "report_review";

export type DelegationScopeOption = {
  scope_kind: "all" | "team";
  scope_id: string | null;
  label: string;
};

export type DelegationListItem = {
  delegation_id: string;
  capability: DelegatedCapability;
  delegate_app_user_id: string;
  delegate_display_name: string;
  template_id: string;
  template_name: string;
  template_version_id?: string;
  scope_kind: "all" | "team";
  scope_id: string | null;
  scope_label: string;
  effective_from: string;
  effective_to: string | null;
  revoked_at?: string | null;
  is_effective?: boolean;
  state?: string;
  status?: string;
  version: number;
};

export type DelegationViewData = {
  items: DelegationListItem[];
  options: {
    delegates: Array<{ app_user_id: string; display_name: string }>;
    templates: Array<{ template_id: string; version_id: string; name: string }>;
    scopes: DelegationScopeOption[];
    capabilities: DelegatedCapability[];
  };
};

export type DelegationCreateSubmissionPayload = {
  capability: DelegatedCapability;
  delegate_app_user_id: string;
  template_id: string;
  scope_kind: "all" | "team";
  scope_id: string | null;
  idempotency_key: string;
};

export type DelegationCreateDraftState = {
  capability: DelegatedCapability | "";
  delegate_id: string;
  template_id: string;
  scope_index: string;
  idempotency_key: string;
  ambiguous_retry_locked: boolean;
  locked_payload: DelegationCreateSubmissionPayload | null;
};

export type ClassifiedDelegationMutationError = {
  code: string;
  message: string;
  shouldRotateIdempotencyKey: boolean;
};

export type DelegationMutationOutcomeInput =
  | { kind: "ok" }
  | { kind: "network_error" }
  | { kind: "invalid_ok_envelope" }
  | {
      kind: "http_error";
      http_status: number;
      classified: ClassifiedDelegationMutationError;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function createDelegationIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function isDelegationViewData(value: unknown): value is DelegationViewData {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.options)) {
    return false;
  }
  const options = value.options;
  return (
    Array.isArray(options.delegates) &&
    options.delegates.every(
      (item) =>
        isRecord(item) &&
        typeof item.app_user_id === "string" &&
        typeof item.display_name === "string",
    ) &&
    Array.isArray(options.templates) &&
    options.templates.every(
      (item) =>
        isRecord(item) &&
        typeof item.template_id === "string" &&
        typeof item.version_id === "string" &&
        typeof item.name === "string",
    ) &&
    Array.isArray(options.scopes) &&
    options.scopes.every(
      (item) =>
        isRecord(item) &&
        (item.scope_kind === "all" || item.scope_kind === "team") &&
        (item.scope_id === null || typeof item.scope_id === "string") &&
        typeof item.label === "string",
    ) &&
    Array.isArray(options.capabilities) &&
    options.capabilities.every(
      (item) => item === "report_assign" || item === "report_review",
    )
  );
}

export function createInitialDelegationCreateDraftState(
  nextIdempotencyKey: () => string = createDelegationIdempotencyKey,
): DelegationCreateDraftState {
  return {
    capability: "",
    delegate_id: "",
    template_id: "",
    scope_index: "",
    idempotency_key: nextIdempotencyKey(),
    ambiguous_retry_locked: false,
    locked_payload: null,
  };
}

/**
 * Applies a field edit to `DelegationCreateDraftState`.
 * When `ambiguous_retry_locked` is true (after a lost/corrupted response or 5xx),
 * edits and idempotency-key rotation are blocked so retrying re-sends the exact
 * same `idempotency_key` and payload without creating a duplicate active delegation.
 */
export function applyDelegationCreateDraftEdit(
  state: DelegationCreateDraftState,
  patch: Partial<
    Pick<
      DelegationCreateDraftState,
      "capability" | "delegate_id" | "template_id" | "scope_index"
    >
  >,
  nextIdempotencyKey: () => string = createDelegationIdempotencyKey,
): DelegationCreateDraftState {
  if (state.ambiguous_retry_locked) {
    return state;
  }
  return {
    ...state,
    ...patch,
    idempotency_key: nextIdempotencyKey(),
    locked_payload: null,
  };
}

export function classifyDelegationMutationError(
  payload: unknown,
  httpStatus: number,
  action: "create" | "revoke" = "create",
): ClassifiedDelegationMutationError {
  const code =
    isRecord(payload) && typeof payload.code === "string"
      ? payload.code
      : httpStatus === 401
        ? "UNAUTHENTICATED"
        : httpStatus === 403
          ? "WORK_REPORT_CAPABILITY_DENIED"
          : "WORK_REPORT_UNAVAILABLE";

  switch (code) {
    case "INVALID_JSON":
    case "REQUEST_BODY_TOO_LARGE":
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "WORK_REPORT_DELEGATION_INVALID":
    case "WORK_REPORT_DELEGATION_CAPABILITY_INVALID":
    case "WORK_REPORT_DELEGATION_SCOPE_INVALID":
    case "WORK_REPORT_SELF_DELEGATION_FORBIDDEN":
    case "WORK_REPORT_TEMPLATE_NOT_ACTIVE":
      return {
        code,
        message:
          action === "create"
            ? "Thông tin ủy quyền không hợp lệ. Vui lòng kiểm tra lại quyền, người nhận, mẫu và phạm vi."
            : "Yêu cầu thu hồi ủy quyền không hợp lệ.",
        shouldRotateIdempotencyKey: true,
      };
    case "NOT_FOUND":
    case "WORK_REPORT_DELEGATION_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy bản ghi ủy quyền hoặc tính năng hiện không khả dụng.",
        shouldRotateIdempotencyKey: true,
      };
    case "WORK_REPORT_DELEGATION_CONFLICT":
    case "WORK_REPORT_VERSION_CONFLICT":
      return {
        code,
        message:
          action === "revoke"
            ? "Trạng thái ủy quyền đã thay đổi. Hãy tải lại danh sách trước khi thử lại."
            : "Yêu cầu tạo ủy quyền xung đột với phiên làm việc hiện tại. Vui lòng thử lại.",
        shouldRotateIdempotencyKey: true,
      };
    case "UNAUTHENTICATED":
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_DENIED":
    case "WORK_REPORT_ACTOR_DENIED":
    case "WORK_REPORT_SCOPE_DENIED":
    case "WORK_REPORT_CAPABILITY_DENIED":
    case "WORK_REPORT_DELEGATE_NOT_AVAILABLE":
    case "WORK_REPORT_DELEGATE_OUTSIDE_SCOPE":
      return {
        code,
        message:
          action === "create"
            ? "Không tạo được ủy quyền. Máy chủ đã từ chối quyền hoặc phạm vi này."
            : "Không thu hồi được ủy quyền do không đủ quyền trên phạm vi này.",
        shouldRotateIdempotencyKey: false,
      };
    case "WORK_REPORT_UNAVAILABLE":
    default: {
      if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 401 && httpStatus !== 403) {
        return {
          code,
          message:
            action === "create"
              ? "Không tạo được ủy quyền. Máy chủ đã từ chối yêu cầu này."
              : "Không thu hồi được ủy quyền. Hãy tải lại danh sách và thử lại.",
          shouldRotateIdempotencyKey: true,
        };
      }
      return {
        code,
        message:
          action === "create"
            ? "Mất phản hồi hoặc hệ thống tạm thời gián đoạn khi tạo ủy quyền. Khóa Idempotency-Key và dữ liệu đã được giữ nguyên; bạn có thể bấm gửi lại an toàn."
            : "Mất phản hồi hoặc hệ thống tạm thời gián đoạn khi thu hồi ủy quyền. Bạn có thể bấm Thu hồi lại an toàn.",
        shouldRotateIdempotencyKey: false,
      };
    }
  }
}

export function isAmbiguousDelegationMutationOutcome(
  outcome: Exclude<DelegationMutationOutcomeInput, { kind: "ok" }>,
): boolean {
  if (outcome.kind === "network_error" || outcome.kind === "invalid_ok_envelope") {
    return true;
  }
  if (outcome.classified.shouldRotateIdempotencyKey) {
    return false;
  }
  if (
    outcome.http_status === 401 ||
    outcome.http_status === 403 ||
    outcome.classified.code === "UNAUTHENTICATED" ||
    outcome.classified.code === "ACTOR_NOT_AVAILABLE" ||
    outcome.classified.code === "CSRF_ORIGIN_DENIED" ||
    outcome.classified.code === "WORK_REPORT_ACTOR_DENIED" ||
    outcome.classified.code === "WORK_REPORT_SCOPE_DENIED" ||
    outcome.classified.code === "WORK_REPORT_CAPABILITY_DENIED" ||
    outcome.classified.code === "WORK_REPORT_DELEGATE_NOT_AVAILABLE" ||
    outcome.classified.code === "WORK_REPORT_DELEGATE_OUTSIDE_SCOPE"
  ) {
    return false;
  }
  return true;
}

export function resolveDelegationCreateSubmissionPayload(
  state: DelegationCreateDraftState,
  selectedScope: DelegationScopeOption | undefined,
):
  | { ok: true; payload: DelegationCreateSubmissionPayload }
  | { ok: false; message: string } {
  if (state.ambiguous_retry_locked && state.locked_payload !== null) {
    return { ok: true, payload: state.locked_payload };
  }
  if (
    !state.capability ||
    !state.delegate_id ||
    !state.template_id ||
    !selectedScope
  ) {
    return {
      ok: false,
      message: "Chọn quyền, người nhận, mẫu và phạm vi hợp lệ.",
    };
  }
  return {
    ok: true,
    payload: {
      capability: state.capability,
      delegate_app_user_id: state.delegate_id,
      template_id: state.template_id,
      scope_kind: selectedScope.scope_kind,
      scope_id: selectedScope.scope_kind === "team" ? selectedScope.scope_id : null,
      idempotency_key: state.idempotency_key,
    },
  };
}

export function applyDelegationCreateMutationOutcome(
  state: DelegationCreateDraftState,
  submittedPayload: DelegationCreateSubmissionPayload,
  outcome: DelegationMutationOutcomeInput,
  nextIdempotencyKey: () => string = createDelegationIdempotencyKey,
): DelegationCreateDraftState {
  if (outcome.kind === "ok") {
    return {
      ...state,
      idempotency_key: nextIdempotencyKey(),
      ambiguous_retry_locked: false,
      locked_payload: null,
    };
  }
  if (
    outcome.kind !== "http_error" ||
    isAmbiguousDelegationMutationOutcome(outcome)
  ) {
    return {
      ...state,
      idempotency_key: submittedPayload.idempotency_key,
      ambiguous_retry_locked: true,
      locked_payload: submittedPayload,
    };
  }
  return {
    ...state,
    idempotency_key: outcome.classified.shouldRotateIdempotencyKey
      ? nextIdempotencyKey()
      : submittedPayload.idempotency_key,
    ambiguous_retry_locked: false,
    locked_payload: null,
  };
}

export async function submitDelegationCreateAttempt(input: {
  state: DelegationCreateDraftState;
  selectedScope: DelegationScopeOption | undefined;
  fetchImpl?: typeof fetch;
  nextIdempotencyKey?: () => string;
}): Promise<
  | {
      ok: true;
      next_state: DelegationCreateDraftState;
      submitted_payload: DelegationCreateSubmissionPayload;
    }
  | {
      ok: false;
      next_state: DelegationCreateDraftState;
      submitted_payload: DelegationCreateSubmissionPayload | null;
      message: string;
    }
> {
  const fetchFn = input.fetchImpl ?? fetch;
  const makeKey = input.nextIdempotencyKey ?? createDelegationIdempotencyKey;
  const resolved = resolveDelegationCreateSubmissionPayload(
    input.state,
    input.selectedScope,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      next_state: input.state,
      submitted_payload: null,
      message: resolved.message,
    };
  }
  const payload = resolved.payload;
  let response: Response;
  try {
    response = await fetchFn("/api/work-reports/delegations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payload.idempotency_key,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    const nextState = applyDelegationCreateMutationOutcome(
      input.state,
      payload,
      { kind: "network_error" },
      makeKey,
    );
    return {
      ok: false,
      next_state: nextState,
      submitted_payload: payload,
      message:
        "Mất phản hồi hoặc kết nối mạng khi tạo ủy quyền. Khóa Idempotency-Key và dữ liệu đã được giữ nguyên; bạn có thể bấm gửi lại an toàn.",
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const classified = classifyDelegationMutationError(body, response.status, "create");
    const nextState = applyDelegationCreateMutationOutcome(
      input.state,
      payload,
      {
        kind: "http_error",
        http_status: response.status,
        classified,
      },
      makeKey,
    );
    return {
      ok: false,
      next_state: nextState,
      submitted_payload: payload,
      message: classified.message,
    };
  }

  if (!isRecord(body) || body.ok !== true) {
    const nextState = applyDelegationCreateMutationOutcome(
      input.state,
      payload,
      { kind: "invalid_ok_envelope" },
      makeKey,
    );
    return {
      ok: false,
      next_state: nextState,
      submitted_payload: payload,
      message:
        "Phản hồi tạo ủy quyền từ máy chủ không hợp lệ nên chưa rõ kết quả. Khóa Idempotency-Key và dữ liệu đã được giữ nguyên; bạn có thể bấm gửi lại an toàn.",
    };
  }

  const nextState = applyDelegationCreateMutationOutcome(
    input.state,
    payload,
    { kind: "ok" },
    makeKey,
  );
  return {
    ok: true,
    next_state: nextState,
    submitted_payload: payload,
  };
}
