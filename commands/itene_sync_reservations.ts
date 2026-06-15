import IteneClient from '#services/itene_client'
import { getIteneConfig } from '#services/itene_config'
import IteneSyncService from '#services/itene_sync_service'
import IteneTokenProvider from '#services/itene_token_provider'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IteneSyncReservations extends BaseCommand {
  static commandName = 'itene:sync-reservations'
  static description = 'Sync ITENE reservation detail data into the local database'
  static options: CommandOptions = {
    startApp: true,
  }

  @flags.string({ description: 'ITENE construction id to sync' })
  declare constructionId?: string

  @flags.boolean({ description: 'Fetch data and print counts without saving records' })
  declare dryRun: boolean

  async run() {
    const config = getIteneConfig()
    const service = new IteneSyncService(
      new IteneClient(config, fetch, new IteneTokenProvider(config))
    )
    const result = await service.syncReservations({
      constructionId: this.constructionId,
      dryRun: this.dryRun,
    })

    this.logger.info(
      [
        'ITENE予約情報:',
        `工事${result.constructions}件`,
        `部屋${result.rooms}件`,
        `予約${result.reservations}件`,
        `作業枠${result.workSlots}件`,
        this.dryRun ? '(dry-run)' : '',
      ]
        .filter(Boolean)
        .join(' ')
    )
  }
}
