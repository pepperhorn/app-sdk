import { createContext, useContext, type ReactNode } from 'react'
import type { PhClient } from '../core/client.js'

const PhContext = createContext<PhClient | null>(null)

/** Holds one PhClient for the hooks below (spec §3.2). */
export function PhProvider(p: { client: PhClient; children: ReactNode }) {
  return <PhContext.Provider value={p.client}>{p.children}</PhContext.Provider>
}

export function usePh(): PhClient {
  const c = useContext(PhContext)
  if (!c) throw new Error('usePh/useAuth: wrap the app in <PhProvider client={…}>.')
  return c
}
