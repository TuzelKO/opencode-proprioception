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
const asArray = (v: unknown): any[] =>
  Array.isArray(v) ? v : Array.isArray((v as any)?.data) ? (v as any).data : []

export default Plugin.define({
  id: "proprioception",
  async setup(ctx) {
    const raw = ctx.options.step
    const step =
      typeof raw === "number" && raw > 0 && raw <= 1 ? raw : 0.05

    // sessionID -> latest measured fill (percent)
    const latest = new Map<string, number>()
    // sessionID -> bucket of the last DELIVERED report
    const delivered = new Map<string, number>()

    await ctx.session.hook("context", async (event: any) => {
      try {
        const sessionID: string | undefined = event.sessionID
        const model: { providerID?: string; id?: string } | undefined = event.model
        if (!sessionID || !model?.providerID || !model?.id) return

        // The window: from the model's own declared limit.
        const models = asArray(await ctx.model.list().catch(() => null))
        const info: any = models.find(
          (m) => m?.providerID === model.providerID && (m?.id ?? m?.modelID) === model.id,
        )
        const window: number | undefined = info?.limit?.context
        if (!window || window <= 0) return

        // The fill: what the last completed turn saw plus what it produced —
        // the context as this request will receive it.
        const messages = asArray(await ctx.session.context({ sessionID }).catch(() => null))
        let fill = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const t = messages[i]?.tokens ?? messages[i]?.info?.tokens
          if (t) {
            fill =
              (t.input || 0) +
              (t.reasoning || 0) +
              (t.output || 0) +
              (t.cache?.read || 0) +
              (t.cache?.write || 0)
            break
          }
        }
        if (fill <= 0) return

        latest.set(sessionID, Math.min(100, (fill / window) * 100))
      } catch {
        // Never break the request over self-knowledge.
      }
    })

    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (event.status !== "completed") return
        const sessionID: string | undefined =
          event.sessionID ?? event.context?.sessionID
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

        // Deliver through `content` — the only field the server persists:
        // it builds the result as to(content, output), where `output` is
        // read ONLY when `content` is empty, and it never is.
        const result = event.result
        if (!result || typeof result === "string") {
          event.result = {
            content: [{ type: "text", text: String(result ?? "") + "\n" + line }],
          }
        } else {
          const content = (result as any).content
          if (typeof content === "string") {
            event.result = { ...result, content: content + "\n" + line }
          } else if (Array.isArray(content)) {
            event.result = {
              ...result,
              content: [...content, { type: "text", text: line }],
            }
          } else {
            event.result = { ...result, content: [{ type: "text", text: line }] }
          }
        }
      } catch {
        // Never break a tool result over self-knowledge.
      }
    })
  },
})
