import type { IteneConfig } from '#services/itene_config'
import type IteneTokenProvider from '#services/itene_token_provider'
import type { IteneAuthSession } from '#services/itene_token_provider'

type Fetcher = typeof fetch
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

export class IteneAuthError extends Error {
  constructor(status: number) {
    super(`ITENE authentication failed with status ${status}`)
    this.name = 'IteneAuthError'
  }
}

export default class IteneClient {
  constructor(
    private config: IteneConfig,
    private fetcher: Fetcher = fetch,
    private tokenProvider?: IteneTokenProvider
  ) {}

  async fetchConstructions(offset = 0, limit = this.config.syncLimit): Promise<unknown> {
    // `dashboard/constructions` は status=2(対応済み)のみ返すため、全状態(未対応0/対応中1/
    // 対応済み2/完了3)を返す `constructions` を使う。offsetページングは有効。
    const url = new URL(`${this.config.apiBaseUrl}/constructions`)
    url.searchParams.set('page', String(Math.floor(offset / limit) + 1))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('limit', String(limit))

    return this.getJson(url)
  }

  async fetchAllConstructions(): Promise<unknown[]> {
    const all: unknown[] = []
    let offset = 0

    for (;;) {
      const response = await this.fetchConstructions(offset, this.config.syncLimit)
      const records = Array.isArray(response)
        ? response
        : Array.isArray((response as any)?.data)
          ? (response as any).data
          : Array.isArray((response as any)?.items)
            ? (response as any).items
            : []

      all.push(...records)

      if (records.length < this.config.syncLimit) {
        return all
      }

      offset += this.config.syncLimit
    }
  }

  async fetchReservationDetail(constructionId: number | string): Promise<unknown> {
    const encodedId = encodeURIComponent(String(constructionId))
    const path = this.config.reservationDetailPath.replace('{constructionId}', encodedId)
    const url = new URL(path.replace(/^\/+/, ''), `${this.config.apiBaseUrl}/`)
    const detail = await this.getJson(url)

    if (isTimetableReservationPath(path)) {
      const metaUrl = new URL(`timetable/constructions/${encodedId}`, `${this.config.apiBaseUrl}/`)
      const meta = await this.getJson(metaUrl).catch(() => ({}))
      return {
        ...(isObject(meta) ? meta : {}),
        TimetableReservations: detail,
      }
    }

    return detail
  }

  async fetchDwellingDetail(constructionId: number | string): Promise<unknown> {
    const encodedId = encodeURIComponent(String(constructionId))
    const url = new URL(`dwellings/${encodedId}`, `${this.config.apiBaseUrl}/`)

    return this.getJson(url)
  }

  private async getJson(url: URL) {
    const authSession = await this.getAuthSession()
    const response = await this.fetchJson(url, authSession)

    if (response.status === 401 || response.status === 403) {
      if (authSession.bearerToken && authSession.cookieHeader) {
        const cookieRetried = await this.fetchJson(url, { cookieHeader: authSession.cookieHeader })
        if (cookieRetried.ok) {
          return cookieRetried.json()
        }
      }

      if (this.tokenProvider) {
        const retried = await this.fetchJson(url, await this.tokenProvider.getAuthSession(true))
        if (retried.status === 401 || retried.status === 403) {
          throw new IteneAuthError(retried.status)
        }

        if (!retried.ok) {
          throw new Error(`ITENE API request failed with status ${retried.status}`)
        }

        return retried.json()
      }

      throw new IteneAuthError(response.status)
    }

    if (!response.ok) {
      throw new Error(`ITENE API request failed with status ${response.status}`)
    }

    return response.json()
  }

  private async getAuthSession(): Promise<IteneAuthSession> {
    if (this.config.bearerToken) {
      return { bearerToken: this.config.bearerToken }
    }

    if (!this.tokenProvider) {
      throw new Error('ITENE_BEARER_TOKEN is not configured')
    }

    return this.tokenProvider.getAuthSession()
  }

  private async fetchJson(url: URL, authSession: IteneAuthSession) {
    const loginOrigin = new URL(this.config.loginUrl).origin
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'origin': loginOrigin,
      'referer': `${loginOrigin}/`,
      'user-agent': BROWSER_USER_AGENT,
      'x-requested-with': 'XMLHttpRequest',
    }

    if (authSession.bearerToken) {
      headers.authorization = `Bearer ${authSession.bearerToken}`
    } else if (authSession.cookieHeader) {
      headers.cookie = authSession.cookieHeader
    }

    return this.fetcher(url, {
      headers,
    })
  }
}

function isTimetableReservationPath(path: string) {
  return /^timetable\/[^/]+$/.test(path.replace(/^\/+/, ''))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
