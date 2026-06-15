import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'itene_construction_rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // オプション申込の有無・商品名・決済状況
      table.boolean('has_option').notNullable().defaultTo(false).index()
      table.string('option_items').nullable()
      table.boolean('option_paid').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('has_option')
      table.dropColumn('option_items')
      table.dropColumn('option_paid')
    })
  }
}
