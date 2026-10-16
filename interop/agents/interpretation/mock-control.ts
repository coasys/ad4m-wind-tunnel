/**
 * Runtime control-plane client for the mock LLM's interpretation rule table
 * (`POST /interp-rules` on `interop/agents/mock-llm/server.mjs`).
 *
 * A driver cannot know every response upfront: a create call's canned reply
 * gets fixed ahead of time, but a *follow-up* call that must reference the base
 * URI the executor minted for that create (an `id` field, so the model's
 * proposal routes to Update instead of a duplicate Create) can only take shape
 * after the first `runInterpretation` call returns. So rules get pushed step
 * by step rather than all supplied via the mock's `MOCK_LLM_INTERP_RULES` env
 * var.
 */

export interface InterpRule {
  /** Human-readable label, echoed in the mock's log when `MOCK_LLM_LOG=1`. */
  label?: string;
  /** Substring(s) that must ALL appear in the raw request body (AND). */
  match: string | string[];
  /** The proposed-instances array to return (auto-`JSON.stringify`d), or a raw
   * string sent verbatim (e.g. wrapped in a code fence / `<think>` block to
   * exercise the executor's noise-stripping parser end to end). */
  response: unknown[] | string;
}

export async function setInterpRules(mockHost: string, mockPort: number, rules: InterpRule[]): Promise<void> {
  const res = await fetch(`http://${mockHost}:${mockPort}/interp-rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  if (!res.ok) {
    throw new Error(`setInterpRules: mock returned HTTP ${res.status}`);
  }
}
