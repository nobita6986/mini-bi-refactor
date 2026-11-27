import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function resolveCandidatePath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
    if (specifier.startsWith("@/")) {
      const target = resolveCandidatePath(path.join(repoRoot, "src", specifier.slice(2)));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return {
        format: "module",
        source: "export default new Proxy({}, { get: (_, prop) => String(prop) });",
        shortCircuit: true,
      };
    }
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      let sourceText = readFileSync(filePath, "utf8");
      if (url.endsWith("/src/components/ui/form-dialog.tsx")) {
        sourceText = sourceText.replace(
          'import { Dialog } from "radix-ui";',
          `import { createElement, Fragment } from "react";
const Dialog = {
  Root: ({ open, children }: any) => (open ? createElement(Fragment, null, children) : null),
  Trigger: ({ children }: any) => createElement(Fragment, null, children),
  Portal: ({ children }: any) => createElement(Fragment, null, children),
  Overlay: (props: any) => createElement("div", props),
  Content: ({ onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...props }: any) =>
    createElement("div", { role: "dialog", ...props }),
  Title: (props: any) => createElement("h2", props),
  Description: (props: any) => createElement("p", props),
  Close: ({ children }: any) => createElement(Fragment, null, children),
};`,
        );
      }
      const transpiled = ts.transpileModule(sourceText, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { BulletinWorkspace } = await import(
  "@/components/bulletins/bulletin-workspace"
);
const { BulletinArticlePreview, BulletinDetailDialog } = await import(
  "@/components/bulletins/bulletin-detail-dialog"
);
const { BulletinEditorDialog } = await import(
  "@/components/bulletins/bulletin-editor-dialog"
);

const BULLETIN_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ATT_ID = "22222222-2222-4222-8222-222222222222";
const PDF_ATT_ID = "33333333-3333-4333-8333-333333333333";

function makeBulletinWithAttachments(overrides = {}) {
  return {
    bulletin_id: BULLETIN_ID,
    id: BULLETIN_ID,
    title: "Thông báo lịch nghỉ Tết Dương Lịch 2027",
    category: "HOLIDAY_SCHEDULE",
    category_display: "Lịch nghỉ lễ",
    badge_text: "Quan trọng",
    is_pinned: true,
    is_read: false,
    published_at: "2026-11-27T08:00:00.000Z",
    published_date_display: "27-11-2026",
    author_display: "Phòng Hành chính - Nhân sự HRPartner",
    summary: "Lịch nghỉ lễ chính thức áp dụng cho toàn bộ nhân sự.",
    content_sections: [
      "Đoạn 1: Thời gian nghỉ từ ngày 01/01/2027 đến hết ngày 03/01/2027.",
      "Đoạn 2: Toàn thể nhân sự quay lại làm việc bình thường vào ngày 04/01/2027.",
    ],
    image_count: 1,
    pdf_count: 1,
    attachment_summary: { image_count: 1, pdf_count: 1 },
    attachments: [
      {
        attachment_id: IMAGE_ATT_ID,
        id: IMAGE_ATT_ID,
        kind: "IMAGE",
        file_name: "banner-tet-2027.png",
        title: "Banner lịch nghỉ Tết 2027",
        mime_type: "image/png",
        file_size_bytes: 245760,
        url: `/api/bulletins/${BULLETIN_ID}/attachments/${IMAGE_ATT_ID}/content`,
        thumbnail_url: null,
        width: 1024,
        height: 576,
        page_count: null,
        sha256: "a".repeat(64),
      },
      {
        attachment_id: PDF_ATT_ID,
        id: PDF_ATT_ID,
        kind: "PDF",
        file_name: "quyet-dinh-nghi-tet-2027.pdf",
        title: "Quyết định nghỉ Tết Dương Lịch 2027",
        mime_type: "application/pdf",
        file_size_bytes: 1048576,
        url: `/api/bulletins/${BULLETIN_ID}/attachments/${PDF_ATT_ID}/content`,
        thumbnail_url: null,
        width: null,
        height: null,
        page_count: 3,
        sha256: "b".repeat(64),
      },
    ],
    status: "PUBLISHED",
    row_version: 2,
    archived_at: null,
    created_at: "2026-11-27T07:50:00.000Z",
    updated_at: "2026-11-27T08:00:00.000Z",
    ...overrides,
  };
}

describe("Slice 3 — HR Bulletins Web UI & Admin CMS", () => {
  it("enforces Server Component page & layout guards, feature flag, and app-shell integration", () => {
    const pageSrc = readRel("src/app/bulletins/page.tsx");
    const layoutSrc = readRel("src/app/bulletins/layout.tsx");
    const appShellSrc = readRel("src/components/app-shell/app-shell.tsx");
    const desktopNavSrc = readRel("src/components/app-shell/desktop-nav.tsx");
    const mobileNavSrc = readRel("src/components/app-shell/mobile-nav.tsx");

    assert.match(pageSrc, /export const dynamic = "force-dynamic"/);
    assert.match(pageSrc, /await connection\(\)/);
    assert.match(pageSrc, /resolveActorForRequest\(\)\.catch\(\(\) => null\)/);
    assert.match(pageSrc, /decideBulletinsPageAccess/);
    assert.match(pageSrc, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
    assert.match(pageSrc, /notFound\(\)/);
    assert.match(pageSrc, /redirect\("\/login\?next=%2Fbulletins"\)/);
    assert.match(pageSrc, /<AccountUnavailable \/>/);
    assert.match(pageSrc, /<TemporaryUnavailable \/>/);
    assert.match(pageSrc, /canManageBulletins/);
    assert.match(pageSrc, /<BulletinWorkspace canManage=\{canManage\} \/>/);

    assert.match(layoutSrc, /export const dynamic = "force-dynamic"/);
    assert.match(layoutSrc, /await connection\(\)/);
    assert.match(layoutSrc, /resolveNavActorForAppShell/);
    assert.match(layoutSrc, /<AppShell actor=\{actor\}>\{children\}<\/AppShell>/);

    assert.match(appShellSrc, /entry\.id !== "bulletins"/);
    assert.match(desktopNavSrc, /bulletins:\s*Newspaper/);
    assert.match(mobileNavSrc, /bulletins:\s*Newspaper/);
  });

  it("renders BulletinWorkspace archive filter controls with explicit label-input pairing and search/form semantics", () => {
    const html = renderToStaticMarkup(
      createElement(BulletinWorkspace, { canManage: false }),
    );

    assert.match(html, /data-testid="bulletins-workspace"/);
    assert.match(html, /Bản tin HRPartner/);
    assert.match(html, /Đánh dấu tất cả đã đọc/);
    assert.match(html, /<search aria-label="Tìm kiếm và lọc bản tin HRPartner">/);
    assert.match(html, /<form>/);

    // Explicit <label for="..."> pairings for archive filter controls
    const expectedLabels = [
      ["bulletins-filter-from-date", "Từ ngày phát hành"],
      ["bulletins-filter-to-date", "Đến ngày phát hành"],
      ["bulletins-filter-category", "Chuyên mục"],
      ["bulletins-filter-author-select", "Người / Bộ phận phát hành"],
      ["bulletins-filter-author", "Lọc tên người phát hành"],
      ["bulletins-filter-q", "Từ khóa"],
    ];
    for (const [id, labelText] of expectedLabels) {
      assert.match(
        html,
        new RegExp(`<label[^>]*for="${id}"[^>]*>${labelText}`),
        `Expected label for=${id} containing "${labelText}"`,
      );
      assert.match(
        html,
        new RegExp(`<(?:input|select)[^>]*id="${id}"`),
        `Expected control with id=${id}`,
      );
    }

    // Status filter and Admin create CTA must be hidden when canManage = false
    assert.doesNotMatch(html, /data-testid="bulletins-filter-status"/);
    assert.doesNotMatch(html, /data-testid="bulletins-create-button"/);
    assert.doesNotMatch(html, /Tạo bản tin mới/);
  });

  it("renders status filter & Admin toolbar only when canManage = true and gates card Admin actions in workspace source", () => {
    const adminHtml = renderToStaticMarkup(
      createElement(BulletinWorkspace, { canManage: true }),
    );

    assert.match(adminHtml, /data-testid="bulletins-filter-status"/);
    assert.match(
      adminHtml,
      /<label[^>]*for="bulletins-filter-status"[^>]*>Trạng thái \(Quản trị\)<\/label>/,
    );
    assert.match(adminHtml, /data-testid="bulletins-create-button"/);
    assert.match(adminHtml, /Tạo bản tin mới/);

    // Verify card Admin toolbar buttons and fail-closed API wiring in workspace source
    const workspaceSrc = readRel("src/components/bulletins/bulletin-workspace.tsx");
    assert.match(workspaceSrc, /\{canManage \? \([\s\S]*data-testid=\{`bulletin-edit-\$\{item\.bulletin_id\}`\}[\s\S]*<span>Sửa<\/span>/);
    assert.match(workspaceSrc, /data-testid=\{`bulletin-pin-toggle-\$\{item\.bulletin_id\}`\}[\s\S]*item\.is_pinned \? "Bỏ ghim" : "Ghim"/);
    assert.match(workspaceSrc, /data-testid=\{`bulletin-publish-\$\{item\.bulletin_id\}`\}[\s\S]*<span>Xuất bản<\/span>/);
    assert.match(workspaceSrc, /data-testid=\{`bulletin-archive-\$\{item\.bulletin_id\}`\}[\s\S]*<span>Lưu trữ<\/span>/);
    assert.match(workspaceSrc, /"Idempotency-Key": newIdempotencyKey\(\)/);
    assert.match(workspaceSrc, /expected_row_version:/);
    assert.match(workspaceSrc, /errorCode === "VERSION_CONFLICT"/);
    assert.match(workspaceSrc, /handleAccessRevoked/);
    assert.match(workspaceSrc, /<AccountUnavailable \/>/);
  });

  it("renders BulletinDetailDialog with full sections, inline /content image dimensions/alt, and PDF iframe/links", () => {
    const item = makeBulletinWithAttachments();
    const html = renderToStaticMarkup(
      createElement(BulletinDetailDialog, {
        open: true,
        onOpenChange: () => {},
        bulletin: item,
        loading: false,
        error: null,
        canManage: false,
      }),
    );

    assert.match(html, /data-testid="bulletin-detail-dialog"/);
    assert.match(html, /Thông báo lịch nghỉ Tết Dương Lịch 2027/);
    assert.match(html, /Lịch nghỉ lễ/);
    assert.match(html, /Quan trọng/);
    assert.match(html, /27-11-2026/);
    assert.match(html, /Phòng Hành chính - Nhân sự HRPartner/);
    assert.match(html, /Đoạn 1: Thời gian nghỉ từ ngày 01\/01\/2027/);
    assert.match(html, /Đoạn 2: Toàn thể nhân sự quay lại làm việc bình thường/);

    // Inline image with explicit width, height, alt, and /content URL
    const imageUrl = `/api/bulletins/${BULLETIN_ID}/attachments/${IMAGE_ATT_ID}/content`;
    assert.match(
      html,
      new RegExp(
        `<img[^>]*src="${imageUrl}"[^>]*alt="Banner lịch nghỉ Tết 2027"[^>]*width="1024"[^>]*height="576"`,
      ),
    );
    assert.match(html, /Mở ảnh gốc/);

    // PDF links using /content URL + preview toggle
    const pdfUrl = `/api/bulletins/${BULLETIN_ID}/attachments/${PDF_ATT_ID}/content`;
    assert.match(html, /Xem trước PDF/);
    assert.match(
      html,
      new RegExp(`<a[^>]*href="${pdfUrl}"[^>]*>.*?Mở PDF trong tab mới`),
    );
    assert.match(
      html,
      new RegExp(
        `<a[^>]*href="${pdfUrl}"[^>]*download="quyet-dinh-nghi-tet-2027\\.pdf"[^>]*>.*?Tải xuống PDF`,
      ),
    );

    // Employee view must not see admin status badge or edit button
    assert.doesNotMatch(html, /data-testid="bulletin-detail-edit"/);
    assert.doesNotMatch(html, /data-testid="bulletin-detail-status-badge"/);

    // Admin detail view renders Chỉnh sửa bản tin + status badge
    const adminDetailHtml = renderToStaticMarkup(
      createElement(BulletinDetailDialog, {
        open: true,
        onOpenChange: () => {},
        bulletin: item,
        loading: false,
        error: null,
        canManage: true,
        onEdit: () => {},
      }),
    );
    assert.match(adminDetailHtml, /data-testid="bulletin-detail-edit"/);
    assert.match(adminDetailHtml, /Chỉnh sửa bản tin/);
    assert.match(adminDetailHtml, /data-testid="bulletin-detail-status-badge"/);

    // Verify inline PDF <iframe title=... src=...> exists when expanded in BulletinDetailDialog source
    const detailSrc = readRel("src/components/bulletins/bulletin-detail-dialog.tsx");
    assert.match(
      detailSrc,
      /<iframe[\s\S]*title=\{`Xem trước PDF: \$\{labelText\}`\}[\s\S]*src=\{att\.url\}/,
    );

    // Loading and error states
    const loadingHtml = renderToStaticMarkup(
      createElement(BulletinDetailDialog, {
        open: true,
        onOpenChange: () => {},
        bulletin: null,
        loading: true,
        error: null,
      }),
    );
    assert.match(loadingHtml, /data-testid="bulletin-detail-loading"/);

    const errorHtml = renderToStaticMarkup(
      createElement(BulletinDetailDialog, {
        open: true,
        onOpenChange: () => {},
        bulletin: null,
        loading: false,
        error: "Không thể tải chi tiết.",
        onRetry: () => {},
      }),
    );
    assert.match(errorHtml, /data-testid="bulletin-detail-error"/);
    assert.match(errorHtml, /Thử lại/);

    // Sanity check BulletinArticlePreview direct rendering
    const previewHtml = renderToStaticMarkup(
      createElement(BulletinArticlePreview, {
        title: "Xem trước",
        category: "HR_NEWS",
        isPinned: false,
        authorDisplay: "Phòng Nhân sự",
        summary: "Tóm tắt",
        contentSections: ["Nội dung đoạn 1"],
        attachments: [],
      }),
    );
    assert.match(previewHtml, /Nội dung đoạn 1/);
  });

  it("renders BulletinEditorDialog with multi-section controls, <=15MB image/PDF inputs, Preview tab, and accessible labels", () => {
    const createHtml = renderToStaticMarkup(
      createElement(BulletinEditorDialog, {
        open: true,
        onOpenChange: () => {},
        editingItem: null,
        onSaved: () => {},
      }),
    );

    assert.match(createHtml, /data-testid="bulletin-editor-dialog"/);
    assert.match(createHtml, /Tạo bản tin mới/);
    assert.match(createHtml, /aria-label="Đóng hộp thoại soạn thảo bản tin"/);

    // Mode switcher tabs ("Soạn thảo" & "Xem trước")
    assert.match(createHtml, /role="tablist"/);
    assert.match(createHtml, /data-testid="bulletin-editor-tab-edit"[^>]*>Soạn thảo/);
    assert.match(createHtml, /data-testid="bulletin-editor-tab-preview"[^>]*>.*?Xem trước/);

    // Explicit label pairing for metadata & multi-section inputs & file uploaders
    for (const id of [
      "bulletin-editor-title",
      "bulletin-editor-category",
      "bulletin-editor-badge",
      "bulletin-editor-author",
      "bulletin-editor-summary",
      "bulletin-editor-pinned",
      "bulletin-editor-section-0",
      "bulletin-editor-upload-images",
      "bulletin-editor-upload-pdfs",
    ]) {
      assert.match(
        createHtml,
        new RegExp(`<label[^>]*for="${id}"`),
        `Expected label for=${id}`,
      );
      assert.match(
        createHtml,
        new RegExp(`id="${id}"`),
        `Expected control id=${id}`,
      );
    }

    // Multi-section controls & 15 MB attachment guidance & accept attributes
    assert.match(createHtml, /data-testid="bulletin-editor-add-section"/);
    assert.match(createHtml, /Thêm đoạn/);
    assert.match(createHtml, /Xóa đoạn/);
    assert.match(createHtml, /Tệp đính kèm \(Ảnh &amp; PDF, tối đa 15 MB\/tệp\)/);
    assert.match(createHtml, /accept="image\/jpeg,image\/png,image\/webp"/);
    assert.match(createHtml, /accept="application\/pdf"/);

    // Footer actions
    assert.match(createHtml, /data-testid="bulletin-editor-cancel"[^>]*>Đóng/);
    assert.match(createHtml, /data-testid="bulletin-editor-archive"[^>]*>.*?Lưu trữ/);
    assert.match(createHtml, /data-testid="bulletin-editor-save-draft"[^>]*>.*?Lưu nháp/);
    assert.match(createHtml, /data-testid="bulletin-editor-publish"[^>]*>.*?Xuất bản/);

    // Edit mode renders existing item attachments + "Lưu thay đổi"
    const editItem = makeBulletinWithAttachments();
    const editHtml = renderToStaticMarkup(
      createElement(BulletinEditorDialog, {
        open: true,
        onOpenChange: () => {},
        editingItem: editItem,
        onSaved: () => {},
      }),
    );
    assert.match(editHtml, /Chỉnh sửa bản tin/);
    assert.match(editHtml, /Lưu thay đổi/);
    assert.match(editHtml, new RegExp(`data-testid="bulletin-editor-attachment-${IMAGE_ATT_ID}"`));
    assert.match(editHtml, new RegExp(`data-testid="bulletin-editor-delete-attachment-${PDF_ATT_ID}"`));
    assert.match(editHtml, /Xóa tệp/);

    // Verify Preview mode renders BulletinArticlePreview in editor source
    const editorSrc = readRel("src/components/bulletins/bulletin-editor-dialog.tsx");
    assert.match(editorSrc, /data-testid="bulletin-editor-preview-panel"[\s\S]*<BulletinArticlePreview/);
    assert.match(editorSrc, /validateAttachmentFileClient/);
  });
});
