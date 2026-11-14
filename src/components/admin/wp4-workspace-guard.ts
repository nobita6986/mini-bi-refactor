"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

export type Wp4TrackedRequest = {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly release: () => void;
};

export type Wp4WorkspaceGuard = {
  readonly getEpoch: () => number;
  readonly isActive: (epoch: number, controller?: AbortController) => boolean;
  readonly trackController: () => Wp4TrackedRequest;
  readonly invalidateSession: () => number;
};

/**
 * Coordinates workspace-wide session epochs and AbortControllers across
 * parallel fetches, section reloads, and in-flight mutations.
 */
export function useWp4WorkspaceGuard(): Wp4WorkspaceGuard {
  const epochRef = useRef(0);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  const getEpoch = useCallback(() => epochRef.current, []);

  const isActive = useCallback(
    (epoch: number, controller?: AbortController) =>
      epochRef.current === epoch && !(controller?.signal.aborted ?? false),
    [],
  );

  const trackController = useCallback((): Wp4TrackedRequest => {
    const controller = new AbortController();
    const epoch = epochRef.current;
    controllersRef.current.add(controller);
    return {
      epoch,
      controller,
      release: () => {
        controllersRef.current.delete(controller);
      },
    };
  }, []);

  const invalidateSession = useCallback((): number => {
    epochRef.current += 1;
    const nextEpoch = epochRef.current;
    for (const controller of Array.from(controllersRef.current)) {
      controller.abort();
    }
    controllersRef.current.clear();
    return nextEpoch;
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      epochRef.current += 1;
      for (const controller of Array.from(controllers)) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  return useMemo(
    () => ({
      getEpoch,
      isActive,
      trackController,
      invalidateSession,
    }),
    [getEpoch, invalidateSession, isActive, trackController],
  );
}
