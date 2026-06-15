import IteneCsvExporter from '#services/itene_csv_exporter'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IteneExportReservationCsv extends BaseCommand {
  static commandName = 'itene:export-reservation-csv'
  static description = 'Export locally stored ITENE reservation data as a UTF-8 BOM CSV'
  static options: CommandOptions = {
    startApp: true,
  }

  @flags.string({ description: 'ITENE construction id or construction code', required: true })
  declare constructionId: string

  @flags.string({ description: 'Output CSV path' })
  declare output?: string

  async run() {
    const result = await new IteneCsvExporter().exportReservationCsv(
      this.constructionId,
      this.output
    )
    this.logger.info(`ITENE予約CSV: ${result.rows}行を出力しました: ${result.path}`)
  }
}
