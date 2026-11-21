"use client";

/**
 * ActivePageLabel — Client Component.
 * Dùng usePathname() + shared A1/A2 matcher `findActiveNavEntry(pathname, items)`
 * để chỉ đọc nhãn sr-only "Đang ở trang: X" khi mục sở hữu thực sự hiển thị trong
 * danh sách menu đã lọc của actor hiện tại (không bao giờ lộ tên mục bị ẩn).
 */

import { usePathname } from "next/navigation";

import { findActiveNavEntry, type NavMenuEntry } from "@/lib/navigation/registry";

export function ActivePageLabel({
  items,
}: {
  items: ReadonlyArray<Pick<NavMenuEntry, "id" | "label">>;
}) {
  const pathname = usePathname();
  const active = findActiveNavEntry(pathname, items);
  return active ? <p className="sr-only">Đang ở trang: {active.label}</p> : null;
}
