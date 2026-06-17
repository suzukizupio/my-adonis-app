import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'itene_construction_rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // 部屋ごとのメッセージ・備考の本文。従来は有無フラグ(has_message/has_remarks)だけを保持していた
      table.text('message').nullable()
      table.text('remarks').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('message')
      table.dropColumn('remarks')
    })
  }
}
