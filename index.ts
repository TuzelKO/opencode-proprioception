import { Plugin } from "@opencode/plugin"

// Proprioception — the model's sense of its own memory, carried INSIDE
// tool results.
//
// The context hook is now a pure OBSERVER: it measures the fill (percent,
// exact tokens, window size) of the assembling request and stores it —
// it pushes nothing, so no transient tail ever ends a cache entry (a cache
// entry ending in a transient line can never prefix-match the next request,
// which made every round pay the previous round as uncached input).
//
// Delivery happens in execute.after: when the fill has crossed a step
// (default 5 percentage points) since the last DELIVERED report, the line
// is appended to the completing tool result — riding content that is fresh
// anyway, persisting in history, costing the cache nothing.
//
// Per session state: parallel sessions and subagents each keep their own
// buckets. Armoured throughout: on any failure the hook stays silent.
type TextPart = { type: "text"; text: string }

// Some calls answer with a bare array, others with a `{ data }` envelope;
// both shapes are accepted so a wrapped answer degrades to silence, not to
// a crash.
const asArray = <T>(v: readonly T[] | { readonly data: readonly T[] } | null): readonly T[] => {
  if (v === null) return []
  return "data" in v ? v.data : v
}

export default Plugin.define({
  id: "proprioception",
  async setup(ctx) {
    const raw = ctx.options?.step
    const step =
      typeof raw === "number" && raw > 0 && raw <= 1 ? raw : 0.05

    // sessionID -> latest measured fill (percent)
    const latest = new Map<string, number>()
    // sessionID -> bucket of the last DELIVERED report
    const delivered = new Map<string, number>()
    // "providerID/modelID" -> declared context window
    const windows = new Map<string, number>()

    await ctx.session.hook("context", async (event) => {
      try {
        const sessionID = event.sessionID
        const model = event.model
        if (!sessionID || !model?.providerID || !model?.id) return

        // The window: from the model's own declared limit. The catalog costs a
        // full list per call and the limit is static for the process, so it is
        // fetched once per model, not once per request.
        const key = `${model.providerID}/${model.id}`
        let window = windows.get(key)
        if (window === undefined) {
          const models = asArray(await ctx.model.list().catch(() => null))
          const info = models.find(
            (m) => m.providerID === model.providerID && (m.id ?? m.modelID) === model.id,
          )
          window = info?.limit.context
          if (!window || window <= 0) return
          windows.set(key, window)
        }

        // The fill: what the last completed turn saw plus what it produced —
        // the context as this request will receive it.
        const messages = asArray(await ctx.session.context({ sessionID }).catch(() => null))
        let fill = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          const t = message.type === "assistant" ? message.tokens : undefined
          if (t) {
            fill =
              (t.input || 0) +
              (t.reasoning || 0) +
              (t.output || 0) +
              (t.cache.read || 0) +
              (t.cache.write || 0)
            break
          }
        }
        if (fill <= 0) return

        latest.set(sessionID, Math.min(100, (fill / window) * 100))
      } catch {
        // Never break the request over self-knowledge.
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.status !== "completed") return
        const sessionID = event.sessionID
        if (!sessionID) return

        const pct = latest.get(sessionID)
        if (pct === undefined) return

        const bucket = Math.floor(pct / (step * 100))
        const prev = delivered.get(sessionID)
        if (prev !== undefined && bucket === prev) return
        delivered.set(sessionID, bucket)

        // Re-derive the exact numbers for the report line.
        const pctWhole = Math.round(pct)
        const line = `[proprioception] context fill: ${pctWhole}% of the window (step ${Math.round(step * 100)}pp, last crossing).`
        const report: TextPart = { type: "text", text: line }

        // The server builds the result from `content`, falling back to
        // `output` only when `content` is absent or empty; a report must
        // therefore never replace a bare `output` — it is folded in front
        // of it instead.
        const result = event.result
        const content = result.content
        if (content === undefined || (Array.isArray(content) && content.length === 0)) {
          const output = result.output
          const parts: TextPart[] =
            output === undefined
              ? [report]
              : [
                  {
                    type: "text",
                    text: typeof output === "string" ? output : JSON.stringify(output),
                  },
                  report,
                ]
          event.result = { ...result, content: parts }
        } else if (typeof content === "string") {
          event.result = { ...result, content: content + "\n" + line }
        } else {
          event.result = { ...result, content: [...content, report] }
        }
      } catch {
        // Never break a tool result over self-knowledge.
      }
    })
  },
})
