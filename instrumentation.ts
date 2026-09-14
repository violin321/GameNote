export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ startMoonScheduler }, { startNintendoStoreScheduler }] = await Promise.all([
    import("./lib/moon/scheduler"),
    import("./lib/nintendo-store/scheduler"),
  ]);

  startMoonScheduler();
  startNintendoStoreScheduler();
}
