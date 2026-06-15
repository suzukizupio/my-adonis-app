import env from '#start/env'

export type IteneConfig = {
  loginUrl: string
  apiBaseUrl: string
  userId?: string
  password?: string
  bearerToken?: string
  reservationDetailPath: string
  tokenProbeUrl?: string
  syncLimit: number
  autoSyncIntervalSeconds?: number
  headless: boolean
  debug: boolean
}

export function getIteneConfig(): IteneConfig {
  return {
    loginUrl: env.get('ITENE_LOGIN_URL') ?? 'https://yuasaquobis.it-ene.com/manage/login',
    apiBaseUrl: (env.get('ITENE_API_BASE_URL') ?? 'https://api.it-ene.com/api/v1').replace(
      /\/+$/,
      ''
    ),
    userId: env.get('ITENE_USER_ID') || undefined,
    password: env.get('ITENE_PASSWORD')?.release() || undefined,
    bearerToken: env.get('ITENE_BEARER_TOKEN') || undefined,
    reservationDetailPath: env.get('ITENE_RESERVATION_DETAIL_PATH') ?? 'timetable/{constructionId}',
    tokenProbeUrl:
      env.get('ITENE_TOKEN_PROBE_URL') ||
      'https://yuasaquobis.it-ene.com/manage/reservations/detail/5006',
    syncLimit: env.get('ITENE_SYNC_LIMIT') ?? 100,
    autoSyncIntervalSeconds: env.get('ITENE_AUTO_SYNC_INTERVAL_SECONDS') ?? 300,
    headless: env.get('ITENE_HEADLESS') ?? true,
    debug: env.get('ITENE_DEBUG') ?? false,
  }
}
