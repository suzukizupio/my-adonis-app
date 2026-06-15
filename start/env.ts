/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // ITENE
  ITENE_LOGIN_URL: Env.schema.string.optional(),
  ITENE_API_BASE_URL: Env.schema.string.optional(),
  ITENE_USER_ID: Env.schema.string.optional(),
  ITENE_PASSWORD: Env.schema.secret.optional(),
  ITENE_BEARER_TOKEN: Env.schema.string.optional(),
  ITENE_RESERVATION_DETAIL_PATH: Env.schema.string.optional(),
  ITENE_TOKEN_PROBE_URL: Env.schema.string.optional(),
  ITENE_SYNC_LIMIT: Env.schema.number.optional(),
  ITENE_AUTO_SYNC_INTERVAL_SECONDS: Env.schema.number.optional(),
  ITENE_HEADLESS: Env.schema.boolean.optional(),
  ITENE_DEBUG: Env.schema.boolean.optional(),
})
