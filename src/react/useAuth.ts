import { useMemo, useSyncExternalStore } from 'react'
import type { AuthStore } from '../core/auth.js'
import type { AuthSnapshot } from '../core/types.js'
import { usePh } from './PhProvider.js'

export type UseAuth = AuthSnapshot & Pick<AuthStore,
  'requestCode' | 'verifyCode' | 'signOut' | 'signOutEverywhere' | 'devices' | 'revokeDevice' | 'updateProfile'>

export function useAuth(): UseAuth {
  const { auth } = usePh()
  const snap = useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot)
  return useMemo(() => ({
    ...snap,
    requestCode: auth.requestCode, verifyCode: auth.verifyCode, signOut: auth.signOut,
    signOutEverywhere: auth.signOutEverywhere, devices: auth.devices, revokeDevice: auth.revokeDevice,
    updateProfile: auth.updateProfile,
  }) as UseAuth, [snap, auth])
}
