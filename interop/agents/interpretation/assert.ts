/** Minimal assertion helpers shared by the I-series drivers — no test framework
 * dependency, just throw-on-failure so `main().catch(...)` in each driver prints
 * a `[iN] FAIL — <reason>` line and exits non-zero for the verify script to catch. */

export class AssertionError extends Error {}

export function assertTrue(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertDefined<T>(value: T | null | undefined, msg: string): asserts value is T {
  if (value === null || value === undefined) throw new AssertionError(msg);
}
