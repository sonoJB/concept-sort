/**
 * Server start-up hook. The Node-only work lives in instrumentation-node.ts and
 * is imported only when running on the Node.js runtime, so it is never
 * analysed for (or bundled into) the Edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
