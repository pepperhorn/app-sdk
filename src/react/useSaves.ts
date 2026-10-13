import { useCallback, useEffect, useState } from 'react'
import { PhError, isPhError } from '../core/errors.js'
import type { SavesClient, UpsertInput } from '../core/saves.js'
import type { SaveSummaryRow } from '../core/types.js'
import { usePh } from './PhProvider.js'
import { useAuth } from './useAuth.js'

const MAX_PAGES = 10 // 10 x 100 covers the gateway's 500-save quota

export function useSaves(kind: string) {
  const client = usePh()
  const { status } = useAuth()
  const signedIn = status === 'signed-in'
  const [items, setItems] = useState<SaveSummaryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<PhError | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setItems([]) // never show another kind's (or another session's) rows
    setError(null)
    if (!signedIn) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void (async () => {
      const all: SaveSummaryRow[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await client.saves.list({ kind, limit: 100, ...(cursor ? { cursor } : {}) })
        all.push(...r.items)
        if (!r.next) break
        cursor = r.next
      }
      return all
    })().then(
      (all) => { if (alive) setItems(all) },
      (e: unknown) => { if (alive) setError(isPhError(e) ? e : new PhError('server')) },
    ).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, kind, signedIn, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const save = useCallback(<T,>(i: UpsertInput<T>) => client.saves.upsert(i).then((r) => { refresh(); return r }), [client, refresh]) as SavesClient['upsert']
  const remove = useCallback(async (externalId: string) => {
    await client.saves.remove(kind, externalId)
    refresh()
  }, [client, kind, refresh])

  return { items, loading, error, refresh, save, remove }
}
