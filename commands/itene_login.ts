import { getIteneConfig } from '#services/itene_config'
import IteneTokenProvider from '#services/itene_token_provider'
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IteneLogin extends BaseCommand {
  static commandName = 'itene:login'
  static description = 'Login to ITENE and verify API authentication data'
  static options: CommandOptions = {
    startApp: true,
  }

  async run() {
    const session = await new IteneTokenProvider(getIteneConfig()).getAuthSession(true)
    const methods = [
      session.bearerToken ? `Bearer token (${session.bearerToken.length} chars)` : '',
      session.cookieHeader ? 'session cookie' : '',
    ].filter(Boolean)

    this.logger.info(`ITENE login: authentication data found via ${methods.join(' and ')}`)
  }
}
