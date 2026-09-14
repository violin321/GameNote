import { NextRequest } from "next/server";
import { json, moonClient, moonErrorResponse, requireMoonAdmin } from "@/lib/moon/api";
import { MoonSidecarError } from "@/lib/moon/sidecar-client";
import { readMoonImportStatus } from "@/lib/moon/import";
import { moonSyncIntervalSeconds, readMoonScheduleStatus } from "@/lib/moon/scheduler";
import type { MoonStatus } from "@/lib/moon/types";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const access = await requireMoonAdmin(request);
    if ("response" in access) return access.response;
    let status: MoonStatus;
    try {
      status = await (await moonClient()).status();
    } catch (error) {
      if (!(error instanceof MoonSidecarError) || error.code !== "sidecar_not_configured")
        throw error;
      status = {
        configured: false,
        linked: false,
        pendingAuthorization: false,
        lastSuccessAt: null,
        lastError: null,
        nextSyncAt: null,
        syncing: false,
        deviceCount: 0,
        reportCount: 0,
        latestReportDate: null,
        scheduler: { enabled: false, intervalSeconds: moonSyncIntervalSeconds },
      };
    }
    const schedule = status.configured ? readMoonScheduleStatus() : null;
    return json({
      ...status,
      ...(schedule
        ? {
            scheduler: schedule.scheduler,
            nextSyncAt: status.linked ? schedule.nextSyncAt : null,
            syncing: status.syncing || schedule.syncing,
            lastError: schedule.lastError || status.lastError,
          }
        : {}),
      importState: await readMoonImportStatus(),
    });
  } catch (error) {
    return moonErrorResponse(error);
  }
}
