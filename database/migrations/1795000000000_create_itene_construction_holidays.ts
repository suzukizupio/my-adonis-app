import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // 予約管理表の「休工」枠（timetable/holidays）。部屋には紐づかず、工事単位で日時範囲を占有する
    this.schema.createTable('itene_construction_holidays', (table) => {
      table.increments('id').notNullable()
      table
        .integer('itene_construction_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('itene_constructions')
        .onDelete('CASCADE')
      table.bigInteger('itene_holiday_id').unsigned().notNullable().unique()
      table.string('name').nullable()
      table.timestamp('start_at').nullable().index()
      table.timestamp('end_at').nullable()
      table.integer('occupancy_count').nullable()
      table.json('raw').nullable()
      table.timestamp('last_synced_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable('itene_construction_holidays')
  }
}
