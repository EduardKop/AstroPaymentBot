export function isValidUrl(s) {
  try { new URL(s); return true } catch { return false }
}

export function parseMoneyOrThrow(input) {
  const s = String(input).replace(',', '.').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('bad money')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) throw new Error('bad money')
  return n
}

export function parseDateTimeOrThrow(input) {
  // ожидаем "YYYY-MM-DD HH:mm"
  const m = String(input).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (!m) throw new Error('bad datetime')
  // Возвращаем строку как есть, база сама разберется или формат ISO
  return input.trim()
}