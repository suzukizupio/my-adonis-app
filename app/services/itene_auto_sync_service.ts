import IteneClient from '#services/itene_client'
import { getIteneConfig } from '#services/itene_config'
import IteneSyncService from '#services/itene_sync_service'
import IteneTokenProvider from '#services/itene_token_provider'

type AutoSyncOptions = {
  force?: boolean
  constructionId?: number | string
  scope?: 'constructions' | 'full'
}

export type AutoSyncResult = {
  attemptedAt?: string
  syncedAt?: string
  skipped: boolean
  error?: string
}

type SyncState = {
  lastAttemptedAt: number
  lastSucceededAt: number
  lastError?: string
  runningSync?: Promise<AutoSyncResult>
}

const constructionListSyncState: SyncState = {
  lastAttemptedAt: 0,
  lastSucceededAt: 0,
}
const fullSyncState: SyncState = {
  lastAttemptedAt: 0,
  lastSucceededAt: 0,
}
const constructionSyncStates = new Map<string, SyncState>()

export async function ensureRecentIteneData(
  options: AutoSyncOptions = {}
): Promise<AutoSyncResult> {
  const config = getIteneConfig()
  const intervalMs = Math.max(0, config.autoSyncIntervalSeconds ?? 300) * 1000
  const now = Date.now()

  if (options.constructionId) {
    const state = getConstructionSyncState(options.constructionId)
    return ensureScopedSync(state, options, intervalMs, now)
  }

  const state = options.scope === 'full' ? fullSyncState : constructionListSyncState
  return ensureScopedSync(
    state,
    { ...options, scope: options.scope ?? 'constructions' },
    intervalMs,
    now
  )
}

function getConstructionSyncState(constructionId: number | string) {
  const key = String(constructionId)
  const state = constructionSyncStates.get(key) ?? {
    lastAttemptedAt: 0,
    lastSucceededAt: 0,
  }

  constructionSyncStates.set(key, state)
  return state
}

function ensureScopedSync(
  state: SyncState,
  options: AutoSyncOptions,
  intervalMs: number,
  now: number
): Promise<AutoSyncResult> {
  if (!options.force && isFresh(state, intervalMs, now)) {
    return Promise.resolve(stateResult(state, true))
  }

  if (state.runningSync) {
    return state.runningSync
  }

  state.lastAttemptedAt = now
  state.runningSync = syncIteneData(options, state)
    .then((result) => {
      state.lastSucceededAt = Date.now()
      state.lastError = undefined
      return {
        ...result,
        syncedAt: new Date(state.lastSucceededAt).toISOString(),
      }
    })
    .catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error)
      return {
        attemptedAt: new Date(state.lastAttemptedAt).toISOString(),
        syncedAt: state.lastSucceededAt ? new Date(state.lastSucceededAt).toISOString() : undefined,
        skipped: false,
        error: state.lastError,
      }
    })
    .finally(() => {
      state.runningSync = undefined
    })

  return state.runningSync
}

function isFresh(state: SyncState, intervalMs: number, now: number) {
  return intervalMs > 0 && now - state.lastAttemptedAt < intervalMs
}

function stateResult(state: SyncState, skipped: boolean): AutoSyncResult {
  return {
    attemptedAt: state.lastAttemptedAt ? new Date(state.lastAttemptedAt).toISOString() : undefined,
    syncedAt: state.lastSucceededAt ? new Date(state.lastSucceededAt).toISOString() : undefined,
    skipped,
    error: state.lastError,
  }
}

async function syncIteneData(options: AutoSyncOptions, state: SyncState): Promise<AutoSyncResult> {
  const config = getIteneConfig()
  const service = new IteneSyncService(
    new IteneClient(config, fetch, new IteneTokenProvider(config))
  )

  if (options.constructionId) {
    await service.syncReservations({ constructionId: options.constructionId })
  } else if (options.scope === 'full') {
    await service.syncConstructions()
    await service.syncReservations()
  } else {
    await service.syncConstructions()
  }

  return {
    attemptedAt: new Date(state.lastAttemptedAt).toISOString(),
    skipped: false,
  }
}
