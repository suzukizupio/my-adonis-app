import IteneClient from '#services/itene_client'
import { getIteneConfig } from '#services/itene_config'
import IteneSyncService from '#services/itene_sync_service'
import IteneTokenProvider from '#services/itene_token_provider'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IteneSyncConstructions extends BaseCommand {
  static commandName = 'itene:sync-constructions'
  static description = 'Sync ITENE construction list into the local database'
  static options: CommandOptions = {
    startApp: true,
  }

  @flags.boolean({ description: 'Fetch data and print counts without saving records' })
  declare dryRun: boolean

  async run() {
    const config = getIteneConfig()
    const service = new IteneSyncService(
      new IteneClient(config, fetch, new IteneTokenProvider(config))
    )
    const result = await service.syncConstructions({ dryRun: this.dryRun })

    this.logger.info(
      `ITENE工事一覧: 工事${result.constructions}件${this.dryRun ? ' (dry-run)' : ''}`
    )
  }
}
