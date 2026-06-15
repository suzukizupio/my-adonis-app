import type { IteneConfig } from '#services/itene_config'

export type IteneAuthSession = {
  bearerToken?: string
  cookieHeader?: string
}

type Fetcher = typeof fetch
type JsonRecord = Record<string, unknown>

const CLIENT_NAME = 'itene-clientside-webapp'
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
const OAUTH_MAX_ATTEMPTS = 3
const OAUTH_RETRY_DELAY_MS = 750

export default class IteneTokenProvider {
  #cachedSession?: IteneAuthSession

  constructor(
    private config: IteneConfig,
    private fetcher: Fetcher = fetch
  ) {}

  async getToken(forceRefresh = false): Promise<string> {
    const session = await this.getAuthSession(forceRefresh)
    return session.bearerToken ?? ''
  }

  async getAuthSession(forceRefresh = false): Promise<IteneAuthSession> {
    if (!forceRefresh && this.config.bearerToken) {
      return { bearerToken: this.config.bearerToken }
    }

    if (!forceRefresh && this.#cachedSession) {
      return this.#cachedSession
    }

    this.#cachedSession = await this.loginWithPasswordGrant()
    return this.#cachedSession
  }

  private async loginWithPasswordGrant(): Promise<IteneAuthSession> {
    if (!this.config.userId || !this.config.password) {
      throw new Error('ITENE_USER_ID and ITENE_PASSWORD are required for automatic login')
    }

    const clientResponse = await this.postFormJson('oauth/client', {
      client_name: CLIENT_NAME,
    })
    const clientId = findStringValue(clientResponse, ['client_id', 'clientId', 'id'])

    if (!clientId) {
      throw new Error('ITENE OAuth client registration succeeded, but no client_id was found')
    }

    const tokenResponse = await this.postFormJson('oauth/token', {
      grant_type: 'password',
      username: this.config.userId,
      password: this.config.password,
      client_id: clientId,
    })
    const bearerToken = extractTokenCandidate(tokenResponse)

    if (!bearerToken) {
      throw new Error('ITENE OAuth login succeeded, but no access token was found')
    }

    return { bearerToken }
  }

  private async postFormJson(endpoint: string, values: Record<string, string>): Promise<unknown> {
    const loginOrigin = new URL(this.config.loginUrl).origin
    const url = new URL(endpoint.replace(/^\/+/, ''), `${this.config.apiBaseUrl}/`)
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/x-www-form-urlencoded',
            'origin': loginOrigin,
            'referer': `${loginOrigin}/`,
            'user-agent': BROWSER_USER_AGENT,
            'x-requested-with': 'XMLHttpRequest',
          },
          body: new URLSearchParams(values),
        })

        if (!response.ok) {
          lastError = new Error(
            `ITENE OAuth request to ${url.pathname} failed with status ${response.status}`
          )

          if (response.status < 500 || attempt === OAUTH_MAX_ATTEMPTS) {
            throw lastError
          }
        } else {
          const body = await response.text()
          try {
            return JSON.parse(body)
          } catch {
            throw new Error(`ITENE OAuth request to ${url.pathname} returned a non-JSON response`)
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        if (attempt === OAUTH_MAX_ATTEMPTS) {
          throw lastError
        }
      }

      await delay(OAUTH_RETRY_DELAY_MS * attempt)
    }

    throw lastError
  }
}

function findStringValue(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as JsonRecord
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate
    }
    if (typeof candidate === 'number') {
      return String(candidate)
    }
  }

  for (const item of Object.values(record)) {
    const candidate = findStringValue(item, keys)
    if (candidate) {
      return candidate
    }
  }
}

function extractTokenCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const jwt = value.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
    if (jwt) {
      return jwt[0]
    }

    try {
      return extractTokenCandidate(JSON.parse(value))
    } catch {
      return extractOpaqueToken(value)
    }
  }

  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as JsonRecord
  const preferredKeys = [
    'access_token',
    'accessToken',
    'auth_token',
    'authToken',
    'bearer',
    'token',
  ]

  for (const key of preferredKeys) {
    const token = extractTokenCandidate(record[key])
    if (token) {
      return token
    }
  }

  for (const item of Object.values(record)) {
    const token = extractTokenCandidate(item)
    if (token) {
      return token
    }
  }
}

function extractOpaqueToken(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const text = value.trim()
  return text.length >= 20 && !/\s/.test(text) ? text : undefined
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
