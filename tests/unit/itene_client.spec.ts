import IteneClient from '#services/itene_client'
import type IteneTokenProvider from '#services/itene_token_provider'
import { test } from '@japa/runner'

test.group('ITENE client', () => {
  test('uses token provider when static bearer token is not configured', async ({ assert }) => {
    const requests: string[] = []
    const client = new IteneClient(
      baseConfig(),
      async (_url, init) => {
        requests.push(String((init?.headers as Record<string, string>).authorization))
        return jsonResponse({ data: [] })
      },
      fakeTokenProvider([{ bearerToken: 'dynamic-token' }])
    )

    await client.fetchConstructions()

    assert.deepEqual(requests, ['Bearer dynamic-token'])
  })

  test('refreshes token once after an authentication failure', async ({ assert }) => {
    const requests: string[] = []
    const client = new IteneClient(
      baseConfig(),
      async (_url, init) => {
        requests.push(String((init?.headers as Record<string, string>).authorization))
        return requests.length === 1 ? jsonResponse({}, 401) : jsonResponse({ data: [] })
      },
      fakeTokenProvider([{ bearerToken: 'expired-token' }, { bearerToken: 'fresh-token' }])
    )

    await client.fetchConstructions()

    assert.deepEqual(requests, ['Bearer expired-token', 'Bearer fresh-token'])
  })

  test('loads timetable construction metadata with timetable reservations', async ({ assert }) => {
    const requests: string[] = []
    const client = new IteneClient(
      {
        ...baseConfig(),
        reservationDetailPath: 'timetable/{constructionId}',
      },
      async (url) => {
        requests.push(String(url))
        return String(url).endsWith('/timetable/5006')
          ? jsonResponse([{ id: 7001 }])
          : jsonResponse({ id: 5006, name: 'Construction meta' })
      },
      fakeTokenProvider([{ bearerToken: 'token' }])
    )

    const detail = await client.fetchReservationDetail(5006)

    assert.deepEqual(requests, [
      'https://api.example.test/api/v1/timetable/5006',
      'https://api.example.test/api/v1/timetable/constructions/5006',
    ])
    assert.deepEqual(detail, {
      id: 5006,
      name: 'Construction meta',
      TimetableReservations: [{ id: 7001 }],
    })
  })
})

function baseConfig() {
  return {
    loginUrl: 'https://example.test/login',
    apiBaseUrl: 'https://api.example.test/api/v1',
    reservationDetailPath: 'constructions/{constructionId}',
    syncLimit: 100,
    headless: true,
    debug: false,
  }
}

function fakeTokenProvider(sessions: Array<{ bearerToken?: string; cookieHeader?: string }>) {
  let index = 0

  return {
    getAuthSession: async (forceRefresh = false) => {
      if (forceRefresh) {
        index = Math.min(index + 1, sessions.length - 1)
      }

      return sessions[index] ?? { bearerToken: 'fallback-token' }
    },
  } as unknown as IteneTokenProvider
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
