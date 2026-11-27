import type { heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import type { LocalOwnerStamp } from "../owner-proof.js";
import { readControllerProcess } from "../controller-process-identity.js";

/**
 * Owner stamps for the native records that `proveOwnerGone` judges (plan
 * Phase 2). The ownership registry and the native recovery paths build their
 * stamps here, so one record has one proof.
 */

type ControllerRow = Pick<typeof nativeRunFinalizations.$inferSelect, "controllerBootId" | "controllerPid"
  | "controllerProcessStartedAt"> & {
  controllerHostHash?: string | null;
  controllerGeneration?: number | null;
  leaseOwner?: string | null;
};

/** Native controller ownership requires its recorded kernel/PID space before
 * a local PID observation. Independent durable stop evidence remains valid. */
export function nativeControllerOwnerStamp(row: ControllerRow, scope: string): LocalOwnerStamp {
  return {
    kind: "local", scope, generation: row.controllerGeneration ?? null, fenceToken: row.leaseOwner, host: null,
    processSpace: row.controllerHostHash ?? null,
    processSpaceUnrecorded: row.controllerHostHash == null, requireRecordedProcessSpace: true,
    bootId: row.controllerBootId, pid: row.controllerPid,
    processStartedAt: row.controllerProcessStartedAt?.toISOString() ?? null, processGroupId: null,
  };
}

type RunProcessRow = Pick<typeof heartbeatRuns.$inferSelect, "processPid" | "processGroupId" | "processStartedAt"> & {
  processHostHash?: string | null;
  controllerProcess?: typeof heartbeatRuns.$inferSelect.controllerProcess;
  runtimeMode?: typeof heartbeatRuns.$inferSelect.runtimeMode;
};

/** heartbeat_runs records the adapter child's PID, group, start time and,
 * since #19871, its PID space (`process_host_hash`, or "remote" for a sandbox
 * PID, which a local probe never judges). With `legacyFallback`, a row saved
 * before that column keeps the one-release local proof; without it, such a row
 * is unprovable. */
export function runProcessOwnerStamp(row: RunProcessRow, scope: string,
  options: { legacyFallback?: boolean } = {}): LocalOwnerStamp {
  const controller = row.runtimeMode === "legacy" ? readControllerProcess(row.controllerProcess) : null;
  // The legacy claim records the launching controller. Bind its boot evidence
  // to this child only when both were stamped in the same local PID space.
  const macKernelBoot = controller && controller.hostHash === row.processHostHash
    && /^[0-9a-f]{32}$/.test(controller.hostHash) ? controller.macKernelBoot : undefined;
  return {
    kind: "local", scope, generation: null, host: null, processSpace: row.processHostHash ?? null,
    ...(macKernelBoot ? { macKernelBoot } : {}),
    ...(options.legacyFallback ? { processSpaceUnrecorded: row.processHostHash == null } : {}),
    bootId: null, pid: row.processPid, processStartedAt: row.processStartedAt?.toISOString() ?? null,
    processGroupId: row.processGroupId,
  };
}
