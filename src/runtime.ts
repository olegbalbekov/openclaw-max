/**
 * Runtime accessor for the MAX channel plugin.
 * Stores the OpenClaw plugin API runtime at registration time.
 */

let _runtime: unknown = null;

export function setMaxRuntime(rt: unknown) {
  _runtime = rt;
}

export function getMaxRuntime(): any {
  if (!_runtime) throw new Error("[openclaw-max] Runtime not initialized");
  return _runtime;
}
