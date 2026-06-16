import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'itene_constructions'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // オプション申込のある部屋数。null = 未取得（予約同期がまだ）、0 = 申込なし、N = N部屋で申込あり
      table.integer('option_application_count').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('option_application_count')
    })
  }
}
