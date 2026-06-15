import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HEADERS = [
  'スペースコード',
  'スペース名',
  '工事名',
  '物件名',
  '工事会社名',
  '郵便番号',
  '住所（都道府県、市区町村、番地、建物名）',
  'QRコード用URL',
  '部屋番号',
  'パスコード',
  '全工事期間開始日',
  '全工事期間終了日',
  '居住区工事期間開始日',
  '居住区工事期間終了日',
  '予約受付期間開始日',
  '予約受付期間終了日',
  ...slotHeaders('通常作業', true),
  ...slotHeaders('追加作業', false),
  ...contactHeaders(),
  '特記事項',
]

export default class IteneCsvExporter {
  async exportReservationCsv(constructionId: number | string, outputPath?: string) {
    const construction = await db
      .from('itene_constructions')
      .where('itene_id', constructionId)
      .orWhere('code', constructionId)
      .firstOrFail()
    const rooms = await db
      .from('itene_construction_rooms')
      .where('itene_construction_id', construction.id)
      .orderBy('floor_no')
      .orderBy('room_no')
    const roomIds = rooms.map((room) => room.id)
    const slots = roomIds.length
      ? await db
          .from('itene_room_work_slots')
          .whereIn('itene_construction_room_id', roomIds)
          .orderBy('work_type')
          .orderBy('sequence')
      : []
    const slotsByRoom = Map.groupBy(slots, (slot) => slot.itene_construction_room_id)
    const rows = rooms.map((room) => {
      const roomSlots = slotsByRoom.get(room.id) ?? []
      const normalSlots = roomSlots.filter((slot) => slot.work_type === 'normal')
      const additionalSlots = roomSlots.filter((slot) => slot.work_type === 'additional')

      return [
        room.space_code,
        room.space_name,
        construction.name,
        construction.building_name,
        '',
        '',
        '',
        '',
        room.room_no,
        '',
        construction.whole_period_start_on,
        construction.whole_period_end_on,
        construction.residential_period_start_on,
        construction.residential_period_end_on,
        construction.reservation_acceptance_period_start_on,
        construction.reservation_acceptance_period_end_on,
        ...slotCells(normalSlots, true),
        ...slotCells(additionalSlots, false),
        ...Array(9).fill(''),
        '',
      ]
    })

    const csv =
      '\ufeff' + [HEADERS, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')
    const filePath = outputPath ?? defaultOutputPath(construction.code ?? construction.itene_id)

    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, csv, 'utf8')

    return { path: filePath, rows: rows.length }
  }
}

function slotHeaders(prefix: string, includeCancelLocked: boolean) {
  return Array.from({ length: 5 }, (_, index) => {
    const seq = index + 1
    const columns = [
      `${prefix}${seq}日付`,
      `${prefix}${seq}開始時間`,
      `${prefix}${seq}終了時間`,
      `${prefix}${seq}予約状況`,
    ]
    return includeCancelLocked ? [...columns, `${prefix}${seq}居住者の取消不可`] : columns
  }).flat()
}

function contactHeaders() {
  return [1, 2, 3].flatMap((seq) => [
    `連絡先${seq}電話番号`,
    `連絡先${seq}メールアドレス`,
    `連絡先${seq}メモ`,
  ])
}

function slotCells(slots: any[], includeCancelLocked: boolean) {
  return Array.from({ length: 5 }, (_, index) => {
    const slot = slots[index]
    const columns = [
      slot?.work_date ?? '',
      slot?.start_time ?? '',
      slot?.end_time ?? '',
      slot?.reservation_status ?? '',
    ]
    return includeCancelLocked ? [...columns, slot?.cancel_locked ? '1' : ''] : columns
  }).flat()
}

function escapeCsv(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function defaultOutputPath(constructionCode: string | number) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return app.tmpPath('itene_exports', `posting-${constructionCode}-${stamp}.csv`)
}
