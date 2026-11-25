"use client";

import type { ReactNode } from "react";
import { Dialog } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * FormDialog — Adaptive Desktop Centered Modal & Mobile Bottom Sheet (`Modern Soft Enterprise`).
 * - Desktop (`sm:`): Centered modal (`max-h-[90dvh] rounded-2xl`).
 * - Mobile (`< 640px`): Bottom Sheet anchored at the bottom (`inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl`)
 *   with sticky header, scrollable content body, and safe-area bottom padding (`env(safe-area-inset-bottom)`).
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionId,
  trigger,
  closeDisabled = false,
  closeAriaLabel = "Đóng hộp thoại",
  onCloseAutoFocus,
  children,
  contentClassName,
  dataTestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  trigger?: ReactNode;
  closeDisabled?: boolean;
  closeAriaLabel?: string;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
  contentClassName?: string;
  dataTestId?: string;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && closeDisabled) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay
          data-ui-overlay-motion="true"
          className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]"
        />
        <Dialog.Content
          data-testid={dataTestId}
          data-ui-dialog-motion="true"
          aria-describedby={descriptionId}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            if (closeDisabled) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (closeDisabled) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (closeDisabled) {
              event.preventDefault();
            }
          }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] w-full overflow-y-auto rounded-t-[24px] border border-border/80 border-t-2 border-t-primary bg-surface p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-foreground shadow-[var(--shadow-dialog)] focus:outline-none",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90dvh] sm:w-[min(38rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] sm:p-6",
            contentClassName,
          )}
        >
          {/* Mobile Bottom Sheet Handle Indicator */}
          <div
            aria-hidden="true"
            className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border sm:hidden"
          />
          <div className="flex items-start justify-between gap-4 border-b border-border pb-3.5">
            <div>
              <Dialog.Title className="text-lg sm:text-xl font-semibold tracking-tight text-[var(--navy)]">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description id={descriptionId} className="mt-1 text-xs sm:text-sm text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={closeAriaLabel}
                disabled={closeDisabled}
                className="inline-flex min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 items-center justify-center rounded-full border border-border bg-surface-muted px-3 text-sm font-medium text-[var(--navy)] transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:border-primary hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ×
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
