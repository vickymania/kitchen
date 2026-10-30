// One call to the Claude Messages API with a JSON-schema answer, shared by
// reading receipts (worker/receipts.js) and labelling recipes
// (worker/labels.js). Plain fetch, no SDK.
//
// The key is the worker secret ANTHROPIC_API_KEY. It is never logged or
// returned: an API error logs only its status code.

export const MODEL = "claude-sonnet-5-5";
// The cheap one, for shelf lives (worker/shelf.js): a short list in, a short list out.
export const CHEAP_MODEL = "claude-haiku-5-5";

/**
 * Ask Claude; resolves to { answer } (the parsed JSON) or { failed } with
 * "network", "rate_limited", "api", "refused" or "unreadable".
 * `what` names the caller in the log line ("receipt read").
 */
export async function askClaude(env, { content, schema, maxTokens, what, model = MODEL }) {
  // Haiku has no server-side fallback: the header and the field go only with Sonnet.
  const fallback = model === MODEL;
  let res;
  try {
    res = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // A declined answer is retried on a fallback model inside the same call.
        ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...(fallback ? { fallbacks: "default" } : {}),
        max_tokens: maxTokens,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content }],
      }),
    });
  } catch {
    return { failed: "network" };
  }
  // Only the status goes into the log; the request carried the key.
  if (!res.ok) {
    console.log(`${what}: Claude API answered ${res.status}`);
    return { failed: res.status === 429 ? "rate_limited" : "api" };
  }
  const data = await res.json().catch(() => null);
  if (data?.stop_reason === "refusal" || data?.stop_reason === "max_tokens") return { failed: "refused" };
  try {
    return { answer: JSON.parse(data?.content?.find((b) => b.type === "text")?.text) };
  } catch {
    return { failed: "unreadable" };
  }
}

/**
 * `n` more paid things in this bucket today: how many of them still fit
 * under `limit` (0..n). The counter goes up by n either way, like takeOne.
 */
export async function takeSome(env, kind, householdId, n, limit) {
  if (!(n > 0)) return 0;
  const bucket = `${kind}:${householdId}:${new Date().toISOString().slice(0, 10)}`;
  const row = await env.DB.prepare(
    "INSERT INTO usage_limits (bucket, count) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + ? RETURNING count",
  ).bind(bucket, n, n).first();
  const count = row?.count ?? n;
  return Math.max(0, Math.min(n, limit - (count - n)));
}

/** One more paid call in this bucket today, or false when `limit` is reached. */
export async function takeOne(env, kind, householdId, limit) {
  const bucket = `${kind}:${householdId}:${new Date().toISOString().slice(0, 10)}`;
  const row = await env.DB.prepare(
    "INSERT INTO usage_limits (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(bucket).first();
  return (row?.count ?? 1) <= limit;
}
