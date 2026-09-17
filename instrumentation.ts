export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build")
    return;
  if (process.env.MOON_AUTO_SYNC_ENABLED === "1") {
    const { startMoonScheduler } = await import("./lib/moon/scheduler");
    startMoonScheduler();
  }
  if (process.env.NINTENDO_STORE_AUTO_SYNC_ENABLED === "1") {
    const { startNintendoStoreScheduler } = await import("./lib/nintendo-store/scheduler");
    startNintendoStoreScheduler();
  }
}
