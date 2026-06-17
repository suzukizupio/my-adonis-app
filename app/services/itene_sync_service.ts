import db from '@adonisjs/lucid/services/db'
import type IteneClient from '#services/itene_client'
import {
  dateOnly,
  inferFloorNo,
  isObject,
  nullableBoolean,
  nullableNumber,
  nullableString,
  rawJson,
  timeOnly,
  timestamp,
  toArray,
  type JsonObject,
} from '#services/itene_mapper'

// status=3 は本物の予約画面に表示されない状態（完了/クローズ等）のため同期から除外する。
// 本物の予約画面は status 0(未対応)/1(対応中)/2(対応済み) の合計152件と一致する。
const HIDDEN_CONSTRUCTION_STATUS = '3'

type SyncOptions = {
  dryRun?: boolean
  constructionId?: number | string
}

type SyncResult = {
  constructions: number
  rooms: number
  reservations: number
  workSlots: number
}

export default class IteneSyncService {
  constructor(private client: IteneClient) {}

  async syncConstructions(options: SyncOptions = {}): Promise<SyncResult> {
    const records = toArray(await this.client.fetchAllConstructions()).filter(
      (record) => String(record.status) !== HIDDEN_CONSTRUCTION_STATUS
    )

    if (options.dryRun) {
      return { constructions: records.length, rooms: 0, reservations: 0, workSlots: 0 }
    }

    for (const record of records) {
      await this.upsertConstruction(record)
    }

    return { constructions: records.length, rooms: 0, reservations: 0, workSlots: 0 }
  }

  async syncReservations(options: SyncOptions = {}): Promise<SyncResult> {
    const constructionIds = options.constructionId
      ? [options.constructionId]
      : await this.getStoredConstructionIds()
    const total: SyncResult = { constructions: 0, rooms: 0, reservations: 0, workSlots: 0 }

    for (const constructionId of constructionIds) {
      const detail = await this.fetchConstructionWithRooms(constructionId)
      const record = normalizeReservationDetail(detail, constructionId)
      const rooms = isObject(record) ? toArray(record.ConstructionRooms) : []
      const reservations = rooms.flatMap((room) => toArray(room.Reservations))

      total.constructions += 1
      total.rooms += rooms.length
      total.reservations += reservations.length
      total.workSlots += reservations.length

      if (options.dryRun || !isObject(record)) {
        continue
      }

      const optionMap = await this.fetchOptionMap(constructionId)
      const holidays = await this.fetchHolidaysSafe(constructionId)

      await db.transaction(async (trx) => {
        const construction = await this.upsertReservationConstruction(record, trx)

        await this.deleteReservationChildrenForConstruction(construction.id, trx)

        for (const room of rooms) {
          const roomIteneId = nullableNumber(room.id)
          const option = roomIteneId !== null ? optionMap.get(roomIteneId) : undefined
          const savedRoom = await this.upsertRoom(construction.id, room, trx, option)
          await this.upsertReservations(savedRoom.id, room, trx)
          await this.upsertWorkSlots(savedRoom.id, room, trx)
        }

        await this.deleteMissingRoomsForConstruction(construction.id, rooms, trx)

        // 休工（部屋に紐づかない作業休止枠）。取得に成功したときだけ入れ替える
        if (holidays !== null) {
          await this.upsertHolidays(construction.id, holidays, trx)
        }

        // 一覧で「オプション申込を受け付けている工事か」を判別できるよう、
        // 申込のある部屋数を工事レコードに保存する（list 同期では上書きされない）
        await trx
          .from('itene_constructions')
          .where('id', construction.id)
          .update({ option_application_count: optionMap.size })
      })
    }

    return total
  }

  private async getStoredConstructionIds(): Promise<number[]> {
    const rows = await db.from('itene_constructions').select('itene_id').orderBy('itene_id')
    return rows.map((row) => Number(row.itene_id))
  }

  private async upsertConstruction(record: JsonObject, client: any = db) {
    const now = nowSql()
    const payload = {
      itene_id: nullableNumber(record.id),
      code: nullableString(record.code),
      name: nullableString(record.name),
      building_name: nullableString(record.buildingName),
      building_id: nullableNumber(record.buildingId),
      building_household: nullableNumber(record.buildingHousehold),
      building_complete_on_date: dateOnly(record.buildingCompleteOnDate),
      reservation_acceptance_period_start_on: dateOnly(record.reservationAcceptancePeriodStartOn),
      reservation_acceptance_period_end_on: dateOnly(record.reservationAcceptancePeriodEndOn),
      whole_period_start_on: dateOnly(record.wholePeriodStartOn),
      whole_period_end_on: dateOnly(record.wholePeriodEndOn),
      residential_period_start_on: dateOnly(record.residentialPeriodStartOn),
      residential_period_end_on: dateOnly(record.residentialPeriodEndOn),
      status: nullableString(record.status),
      work_start_time: timeOnly(record.workStartTime),
      work_end_time: timeOnly(record.workEndTime),
      break_start_time: timeOnly(record.breakStartTime),
      break_end_time: timeOnly(record.breakEndTime),
      message_to_resident: nullableString(record.messageToResident),
      itene_created_at: timestamp(record.createdAt),
      itene_updated_at: timestamp(record.updatedAt),
      raw: rawJson(record),
      last_synced_at: now,
      updated_at: now,
    }

    if (!payload.itene_id) {
      throw new Error('ITENE construction id is missing')
    }

    await client
      .table('itene_constructions')
      .insert({ ...payload, created_at: now })
      .onConflict('itene_id')
      .merge(payload)

    return client.from('itene_constructions').where('itene_id', payload.itene_id).firstOrFail()
  }

  private async fetchConstructionWithRooms(constructionId: number | string) {
    const client = this.client as IteneClient & {
      fetchDwellingDetail?: (constructionId: number | string) => Promise<unknown>
    }

    if (typeof client.fetchDwellingDetail === 'function') {
      try {
        return await client.fetchDwellingDetail(constructionId)
      } catch {
        return this.client.fetchReservationDetail(constructionId)
      }
    }

    return this.client.fetchReservationDetail(constructionId)
  }

  // 工事のオプション申込一覧を取得し、部屋(itene_room_id) => 申込内容 のマップにする。
  // 取得に失敗してもオプション無し扱いで同期全体は継続する。
  private async fetchOptionMap(constructionId: number | string) {
    const map = new Map<number, { items: string[]; paid: boolean }>()
    const client = this.client as IteneClient & {
      fetchOptionApplications?: (constructionId: number | string) => Promise<unknown>
    }

    if (typeof client.fetchOptionApplications !== 'function') {
      return map
    }

    try {
      const applications = toArray(await client.fetchOptionApplications(constructionId))
      for (const application of applications) {
        const roomIteneId = nullableNumber(application.constructionRoomId)
        if (roomIteneId === null) {
          continue
        }

        const entry = map.get(roomIteneId) ?? { items: [], paid: false }
        for (const item of toArray(application.Items)) {
          const name = nullableString(item.optionalItemName)
          if (name) {
            entry.items.push(name)
          }
        }
        if (
          toArray(application.PaymentStatus).some(
            (payment) => String(payment.status ?? '').toUpperCase() === 'CAPTURE'
          )
        ) {
          entry.paid = true
        }
        map.set(roomIteneId, entry)
      }
    } catch {
      // オプション取得に失敗した場合は空のまま（オプション無し扱い）
    }

    return map
  }

  // 休工一覧を取得する。取得失敗時は null を返し、既存の休工を消さないようにする
  private async fetchHolidaysSafe(constructionId: number | string): Promise<JsonObject[] | null> {
    const client = this.client as IteneClient & {
      fetchHolidays?: (constructionId: number | string) => Promise<unknown>
    }

    if (typeof client.fetchHolidays !== 'function') {
      return null
    }

    try {
      return toArray(await client.fetchHolidays(constructionId))
    } catch {
      return null
    }
  }

  // 休工を保存する。部屋に紐づかないため工事単位で全削除→再投入する
  private async upsertHolidays(
    constructionLocalId: number,
    holidays: JsonObject[],
    client: any = db
  ) {
    const now = nowSql()

    await client
      .from('itene_construction_holidays')
      .where('itene_construction_id', constructionLocalId)
      .delete()

    for (const record of holidays) {
      const iteneHolidayId = nullableNumber(record.id)
      if (!iteneHolidayId) {
        continue
      }

      const payload = {
        itene_construction_id: constructionLocalId,
        itene_holiday_id: iteneHolidayId,
        name: nullableString(record.name),
        start_at: timestamp(record.startAt),
        end_at: timestamp(record.endAt),
        occupancy_count: nullableNumber(record.occupancyCount),
        raw: rawJson(record),
        last_synced_at: now,
        updated_at: now,
      }

      await client
        .table('itene_construction_holidays')
        .insert({ ...payload, created_at: now })
        .onConflict('itene_holiday_id')
        .merge(payload)
    }
  }

  private async upsertReservationConstruction(record: JsonObject, client: any = db) {
    const iteneId = nullableNumber(record.id)
    if (!iteneId) {
      throw new Error('ITENE construction id is missing')
    }

    const existing = await client.from('itene_constructions').where('itene_id', iteneId).first()
    if (!hasConstructionDetails(record)) {
      if (existing?.code || existing?.name || existing?.building_name) {
        return existing
      }

      return this.upsertConstruction({ id: iteneId }, client)
    }

    return this.upsertConstruction(record, client)
  }

  private async upsertRoom(
    constructionLocalId: number,
    record: JsonObject,
    client: any = db,
    option?: { items: string[]; paid: boolean }
  ) {
    const now = nowSql()
    const reservations = toArray(record.Reservations)
    // メッセージ・備考は有無フラグだけでなく本文も保存する（一覧で内容を確認できるように）
    const message = nullableString(record.message)
    const remarks = nullableString(record.remarks)
    const payload = {
      itene_construction_id: constructionLocalId,
      itene_room_id: nullableNumber(record.id),
      construction_id: nullableNumber(record.constructionId),
      construction_code: nullableString(record.constructionCode),
      building_id: nullableNumber(record.buildingId),
      floor_no: nullableNumber(record.floorNo) ?? inferFloorNo(record.roomNo),
      room_no: nullableString(record.roomNo),
      space_code: nullableString(record.spaceCode),
      space_name: nullableString(record.spaceName),
      status: nullableString(record.status),
      has_reservation: reservations.length > 0,
      message,
      remarks,
      has_message: Boolean(message),
      has_remarks: Boolean(remarks),
      has_additional_flag: reservations.some((reservation) =>
        nullableBoolean(reservation.additionalFlag)
      ),
      has_option: Boolean(option),
      option_items:
        option && option.items.length > 0 ? [...new Set(option.items)].join(' / ') : null,
      option_paid: Boolean(option?.paid),
      itene_created_at: timestamp(record.createdAt),
      itene_updated_at: timestamp(record.updatedAt),
      raw: rawJson(record),
      last_synced_at: now,
      updated_at: now,
    }

    if (!payload.itene_room_id) {
      throw new Error('ITENE room id is missing')
    }

    await client
      .table('itene_construction_rooms')
      .insert({ ...payload, created_at: now })
      .onConflict('itene_room_id')
      .merge(payload)

    return client
      .from('itene_construction_rooms')
      .where('itene_room_id', payload.itene_room_id)
      .firstOrFail()
  }

  private async upsertReservations(roomLocalId: number, room: JsonObject, client: any = db) {
    const now = nowSql()

    for (const record of toArray(room.Reservations)) {
      const payload = {
        itene_construction_room_id: roomLocalId,
        itene_reservation_id: nullableNumber(record.id),
        construction_id: nullableNumber(record.constructionId),
        construction_room_id: nullableNumber(record.constructionRoomId),
        floor_no: nullableNumber(record.floorNo),
        room_no: nullableString(record.roomNo),
        start_at: timestamp(record.startAt),
        end_at: timestamp(record.endAt),
        status: nullableString(record.status),
        additional_flag: Boolean(nullableBoolean(record.additionalFlag)),
        lock_room_owner: Boolean(nullableBoolean(record.lockRoomOwner ?? record.lock4RoomOwner)),
        main_charge: nullableString(record.mainCharge),
        sub_charge: nullableString(record.subCharge),
        reservation_date: timestamp(record.reservationDate),
        itene_created_at: timestamp(record.createdAt),
        itene_updated_at: timestamp(record.updatedAt),
        raw: rawJson(record),
        last_synced_at: now,
        updated_at: now,
      }

      if (!payload.itene_reservation_id) {
        continue
      }

      await client
        .table('itene_reservations')
        .insert({ ...payload, created_at: now })
        .onConflict('itene_reservation_id')
        .merge(payload)
    }
  }

  private async upsertWorkSlots(roomLocalId: number, room: JsonObject, client: any = db) {
    const now = nowSql()
    const counters = { normal: 0, additional: 0 }
    const reservations = toArray(room.Reservations).sort((a, b) =>
      String(a.startAt ?? '').localeCompare(String(b.startAt ?? ''))
    )

    for (const record of reservations) {
      const workType = nullableBoolean(record.additionalFlag) ? 'additional' : 'normal'
      const sequence = ++counters[workType]
      const payload = {
        itene_construction_room_id: roomLocalId,
        itene_reservation_id: nullableNumber(record.id),
        work_type: workType,
        sequence,
        work_date: dateOnly(record.reservationDate) ?? dateOnly(record.startAt),
        start_time: timeOnly(record.startAt),
        end_time: timeOnly(record.endAt),
        reservation_status: nullableString(record.status),
        cancel_locked: nullableBoolean(record.lockRoomOwner ?? record.lock4RoomOwner),
        raw: rawJson(record),
        updated_at: now,
      }

      await client
        .table('itene_room_work_slots')
        .insert({ ...payload, created_at: now })
        .onConflict(['itene_construction_room_id', 'work_type', 'sequence'])
        .merge(payload)
    }
  }

  private async deleteReservationChildrenForConstruction(
    constructionLocalId: number,
    client: any = db
  ) {
    const roomRows = await client
      .from('itene_construction_rooms')
      .select('id')
      .where('itene_construction_id', constructionLocalId)
    const roomIds = roomRows.map((room: { id: number }) => room.id)

    if (roomIds.length === 0) {
      return
    }

    await client
      .from('itene_room_work_slots')
      .whereIn('itene_construction_room_id', roomIds)
      .delete()
    await client.from('itene_reservations').whereIn('itene_construction_room_id', roomIds).delete()
  }

  private async deleteMissingRoomsForConstruction(
    constructionLocalId: number,
    rooms: JsonObject[],
    client: any = db
  ) {
    const roomIds = rooms.map((room) => nullableNumber(room.id)).filter((id) => id !== null)

    if (roomIds.length === 0) {
      return
    }

    await client
      .from('itene_construction_rooms')
      .where('itene_construction_id', constructionLocalId)
      .whereNotIn('itene_room_id', roomIds)
      .delete()
  }
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function normalizeReservationDetail(detail: unknown, constructionId: number | string) {
  const payload = isObject(detail) && isObject(detail.data) ? detail.data : detail

  if (Array.isArray(payload)) {
    return buildConstructionFromTimetable(constructionId, payload)
  }

  if (isObject(payload) && Array.isArray(payload.TimetableReservations)) {
    const { TimetableReservations, ...construction } = payload
    return {
      ...construction,
      ConstructionRooms: buildConstructionFromTimetable(constructionId, TimetableReservations)
        .ConstructionRooms,
    }
  }

  if (isObject(payload) && isObject(payload.Construction)) {
    return payload.Construction
  }

  return payload
}

function buildConstructionFromTimetable(constructionId: number | string, reservations: unknown[]) {
  const rooms = new Map<string, JsonObject>()
  const firstReservation = reservations.find(isObject)
  const constructionItEneId =
    nullableNumber(firstReservation?.constructionId) ?? nullableNumber(constructionId)

  for (const reservation of reservations) {
    if (!isObject(reservation)) {
      continue
    }

    const roomId = nullableNumber(reservation.constructionRoomId)
    const key = String(roomId ?? reservation.roomNo ?? reservation.id)
    const room = rooms.get(key) ?? createRoomFromReservation(reservation, constructionId)
    const roomReservations = Array.isArray(room.Reservations) ? room.Reservations : []

    roomReservations.push({
      ...reservation,
      lockRoomOwner: reservation.lockRoomOwner ?? reservation.lock4RoomOwner,
    })
    room.Reservations = roomReservations
    rooms.set(key, room)
  }

  return {
    id: constructionItEneId ?? constructionId,
    ConstructionRooms: Array.from(rooms.values()),
  }
}

function createRoomFromReservation(reservation: JsonObject, constructionId: number | string) {
  const constructionRoom = isObject(reservation.ConstructionRoom)
    ? reservation.ConstructionRoom
    : {}

  return {
    ...constructionRoom,
    id: nullableNumber(reservation.constructionRoomId) ?? nullableNumber(constructionRoom.id),
    constructionId: nullableNumber(reservation.constructionId) ?? nullableNumber(constructionId),
    floorNo: reservation.floorNo,
    roomNo: reservation.roomNo,
    Reservations: [],
  }
}

function hasConstructionDetails(record: JsonObject) {
  return ['code', 'name', 'buildingName', 'status'].some((key) => record[key] !== undefined)
}
