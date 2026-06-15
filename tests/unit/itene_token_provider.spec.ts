import IteneTokenProvider from '#services/itene_token_provider'
import { test } from '@japa/runner'

test.group('ITENE token provider', () => {
  test('logs in with the ITENE OAuth password grant', async ({ assert }) => {
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = []
    const provider = new IteneTokenProvider(baseConfig(), async (url, init) => {
      requests.push({
        url: String(url),
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      })

      return requests.length === 1
        ? jsonResponse({ client_id: 'client-1' })
        : jsonResponse({ tokeninfo: { access_token: 'a'.repeat(24) } })
    })

    const session = await provider.getAuthSession(true)

    assert.equal(session.bearerToken, 'a'.repeat(24))
    assert.lengthOf(requests, 2)
    assert.equal(requests[0].url, 'https://api.example.test/api/v1/oauth/client')
    assert.equal(requests[0].body, 'client_name=itene-clientside-webapp')
    assert.equal(requests[1].url, 'https://api.example.test/api/v1/oauth/token')
    assert.include(requests[1].body, 'grant_type=password')
    assert.include(requests[1].body, 'username=user-1')
    assert.include(requests[1].body, 'password=pass-1')
    assert.include(requests[1].body, 'client_id=client-1')
    assert.equal(requests[1].headers.origin, 'https://example.test')
    assert.equal(requests[1].headers.referer, 'https://example.test/')
    assert.equal(requests[1].headers['x-requested-with'], 'XMLHttpRequest')
  })

  test('uses configured bearer token without calling the login endpoints', async ({ assert }) => {
    let called = false
    const provider = new IteneTokenProvider(
      {
        ...baseConfig(),
        bearerToken: 'static-token',
      },
      async () => {
        called = true
        return jsonResponse({})
      }
    )

    const session = await provider.getAuthSession()

    assert.equal(session.bearerToken, 'static-token')
    assert.isFalse(called)
  })
})

function baseConfig() {
  return {
    loginUrl: 'https://example.test/manage/login',
    apiBaseUrl: 'https://api.example.test/api/v1',
    userId: 'user-1',
    password: 'pass-1',
    reservationDetailPath: 'constructions/{constructionId}',
    syncLimit: 100,
    headless: true,
    debug: false,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
