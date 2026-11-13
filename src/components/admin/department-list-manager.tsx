"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  classifyDepartmentReadError,
  departmentDefaultPolicyDescription,
  departmentMembershipModeLabel,
  departmentScaleSummary,
  projectDepartmentListEnvelope,
} from "@/lib/admin/department-ui-model";
import type { DepartmentListProjection } from "@/lib/departments/department-contract";

type DepartmentListLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: DepartmentListProjection }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

export function DepartmentListManager() {
  const [state, setState] = useState<DepartmentListLoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch("/api/admin/departments", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách Phòng ban.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setState({ kind: "denied", message: failure.message });
          return;
        }
        setState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentListEnvelope(payload);
      if (!projected) {
        setState({
          kind: "error",
          message: "Phản hồi danh sách Phòng ban không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setState({ kind: "ready", list: projected });
    })();

    return () => controller.abort();
  }, [reloadToken]);

  const reloadList = () => {
    setState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  return (
    <PageShell
      dataTestId="departments-admin-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <PageHeader
        eyebrow="Tổ chức hệ thống"
        title="Phòng ban"
        description="Danh mục Phòng ban hệ thống dành cho Full Admin. Phòng Tuyển dụng chiếu danh sách Nhóm ở chế độ chỉ đọc; Phòng Kế toán quản lý thành viên nhận quyền tài chính Vendor cố định."
        actions={
          <Button
            variant="secondary"
            size="md"
            onClick={reloadList}
            disabled={state.kind === "loading"}
          >
            Làm mới
          </Button>
        }
      />

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách Phòng ban…
          </p>
        </Card>
      ) : null}

      {state.kind === "denied" ? (
        <Alert tone="error" role="alert" title="Không có quyền truy cập">
          {state.message}
        </Alert>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách Phòng ban"
              detail={state.message}
            />
            {state.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadList}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {state.kind === "ready" && state.list.departments.length === 0 ? (
        <Card>
          <div className="space-y-3">
            <EmptyState
              title="Chưa có phòng ban hệ thống"
              description="Hệ thống hiện chưa có bản ghi Phòng ban nào để hiển thị."
            />
            <div className="flex justify-center">
              <Button variant="secondary" onClick={reloadList}>
                Thử tải lại
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {state.kind === "ready" && state.list.departments.length > 0 ? (
        <Card>
          <CardHeader
            title="Danh sách Phòng ban hệ thống"
            description={`Ngày hiệu lực hệ thống: ${state.list.authorization_date} · ${state.list.departments.length} phòng ban`}
          />
          <DataTableContainer dataTestId="departments-list-table">
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Phòng ban
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Quy mô hiện tại
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Chế độ &amp; Quyền mặc định (chỉ đọc)
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.list.departments.map((department) => {
                  const isAccounting = department.system_key === "ACCOUNTING";
                  return (
                    <tr
                      key={department.department_id}
                      data-testid={`department-row-${(department.system_key ?? department.code).toLowerCase()}`}
                      className={DATA_TABLE_ROW_CLASS}
                    >
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="font-semibold text-foreground">{department.name}</div>
                        <div className="mt-0.5 font-mono text-xs text-muted">
                          Mã: {department.code}
                        </div>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
                          {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </td>
                      <td
                        data-label="Quy mô hiện tại"
                        className={`${DATA_TABLE_TD_CLASS} tabular-nums`}
                      >
                        {departmentScaleSummary(department)}
                      </td>
                      <td data-label="Quyền mặc định" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-1">
                          <StatusBadge tone={isAccounting ? "primary" : "neutral"}>
                            {departmentMembershipModeLabel(department)}
                          </StatusBadge>
                          <p className="max-w-md text-xs text-muted whitespace-normal">
                            {departmentDefaultPolicyDescription(department)}
                          </p>
                        </div>
                      </td>
                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} text-right`}
                      >
                        <RowActionCluster>
                          <Link
                            href={`/admin/departments/${encodeURIComponent(department.department_id)}`}
                            className={buttonClasses({
                              variant: isAccounting ? "primary" : "secondary",
                              size: "sm",
                            })}
                          >
                            {isAccounting
                              ? "Quản lý thành viên"
                              : department.system_key === "RECRUITMENT"
                                ? "Xem danh sách Nhóm"
                                : "Xem thông tin"}
                          </Link>
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        </Card>
      ) : null}
    </PageShell>
  );
}
