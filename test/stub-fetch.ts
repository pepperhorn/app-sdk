// A route-table fetch for unit tests. Keys are `METHOD /path`; a handler
// array answers in order and repeats its last entry.
export interface StubCall { method: string; path: string; query: Record<string, string>; auth: string | null; body: unknown }
export type StubHandler = (call: StubCall) => Response | Promise<Response>

export const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e.abcdefghijklmnopqrstuvwx'

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

export function stubFetch(routes: Record<string, StubHandler | StubHandler[]>) {
  const calls: StubCall[] = []
  const queues = new Map<string, StubHandler | StubHandler[]>(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  )
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    const call: StubCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: headers.get('Authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const key = `${call.method} ${call.path}`
    const h = queues.get(key)
    if (!h) throw new Error(`stubFetch: no route for ${key}`)
    if (Array.isArray(h)) {
      const next = h.length > 1 ? h.shift() : h[0]
      if (!next) throw new Error(`stubFetch: ${key} has no handlers`)
      return next(call)
    }
    return h(call)
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}
