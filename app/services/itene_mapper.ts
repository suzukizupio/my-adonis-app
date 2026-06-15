export type JsonObject = Record<string, any>

const SENSITIVE_KEYS = new Set([
  'authorization',
  'bearer',
  'cookie',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'token',
  'name',
  'email',
  'phone',
  'passcode',
  'qrUrl',
  'qr_url',
  'qrCodeUrl',
  'QRコード用URL',
])

export function toArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is JsonObject => isObject(item))
  }

  if (isObject(value)) {
    for (const key of ['data', 'items', 'results', 'constructions', 'ConstructionRooms']) {
      if (Array.isArray(value[key])) {
        return value[key].filter((item): item is JsonObject => isObject(item))
      }
    }
  }

  return []
}

export function sanitizeRaw(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRaw(item))
  }

  if (!isObject(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEYS.has(key))
      .map(([key, item]) => [key, sanitizeRaw(item)])
  )
}

export function rawJson(value: unknown) {
  return JSON.stringify(sanitizeRaw(value))
}

export function nullableString(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return String(value)
}

export function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function nullableBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value !== 0
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', '不可'].includes(value.toLowerCase())
  }

  return Boolean(value)
}

export function dateOnly(value: unknown): string | null {
  const text = nullableString(value)
  if (!text) {
    return null
  }

  return text.slice(0, 10)
}

export function timeOnly(value: unknown): string | null {
  const text = nullableString(value)
  if (!text) {
    return null
  }

  if (/^\d{2}:\d{2}/.test(text)) {
    return text.slice(0, 8)
  }

  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().slice(11, 19)
}

export function timestamp(value: unknown): string | null {
  const text = nullableString(value)
  if (!text) {
    return null
  }

  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

export function inferFloorNo(roomNo: unknown): number | null {
  const text = nullableString(roomNo)
  const match = text?.match(/^(\d{1,2})\d{2}$/)
  return match ? Number(match[1]) : null
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null
}
