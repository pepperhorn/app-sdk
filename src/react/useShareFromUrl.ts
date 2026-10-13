import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod/v4'
import { PhError, isPhError } from '../core/errors.js'
import { parseShareCode } from '../core/shares.js'
import type { ResolvedShare } from '../core/types.js'
import { usePh } from './PhProvider.js'
import { useAuth } from './useAuth.js'

export type ShareFromUrlState = 'none' | 'loading' | 'ready' | 'missing' | 'error'

const NONE = { state: 'none' as ShareFromUrlState, share: null, error: null }
const LOADING = { state: 'loading' as ShareFromUrlState, share: null, error: null }

/**
 * Resolves `/s/<code>` (or `pattern`) once auth has settled, so isOwner/canEdit are right first time.
 * `pathname` defaults to `location.pathname` read at render: the caller must re-render on navigation.
 */
export function useShareFromUrl<T = unknown>(o: { pattern?: RegExp; schema?: z.ZodType<T>; pathname?: string } = {}) {
  const client = usePh()
  const { status } = useAuth()
  const pathname = o.pathname ?? (typeof location === 'undefined' ? '/' : location.pathname)
  const code = parseShareCode(pathname, o.pattern)
  const schemaRef = useRef(o.schema)
  useEffect(() => { schemaRef.current = o.schema })
  const [s, setS] = useState<{ state: ShareFromUrlState; share: ResolvedShare<T> | null; error: PhError | null }>(
    { state: code ? 'loading' : 'none', share: null, error: null })

  useEffect(() => {
    if (!code) {
      setS({ state: 'none', share: null, error: null })
      return
    }
    if (status === 'unknown') return
    let alive = true
    setS({ state: 'loading', share: null, error: null })
    client.shares.resolve<T>(code, schemaRef.current).then(
      (share) => { if (alive) setS(share ? { state: 'ready', share, error: null } : { state: 'missing', share: null, error: null }) },
      (e: unknown) => { if (alive) setS({ state: 'error', share: null, error: isPhError(e) ? e : new PhError('server') }) },
    )
    return () => { alive = false }
  }, [client, code, status])

  if (!code) return NONE
  if (status === 'unknown') return LOADING
  return s
}
