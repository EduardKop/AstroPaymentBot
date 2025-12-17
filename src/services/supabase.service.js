import { createClient } from '@supabase/supabase-js'

// Инициализация клиента будет внутри функций или глобально, если переменные загружены
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

const supabase = createClient(supabaseUrl || '', supabaseKey || '')

export async function findManagerByTelegramIdInDB(telegramId) {
  const tgIdStr = String(telegramId)

  const { data, error } = await supabase
    .from('managers')
    .select('*')
    .eq('telegram_id', tgIdStr)
    .eq('status', 'active')
    .single()

  if (error || !data) return null

  // Парсим страны. В Supabase это может быть массив ["PL", "DE"] или строка json
  let countriesRaw = ''
  if (Array.isArray(data.geo)) {
    countriesRaw = data.geo.join(',')
  } else if (typeof data.geo === 'string') {
    countriesRaw = data.geo.replace(/[\[\]"]/g, '')
  }

  return {
    id: data.id,
    name: data.name,
    telegramId: data.telegram_id,
    countriesRaw: countriesRaw
  }
}

export async function insertPayment(p) {
  // Формат для Postgres timestamptz: "2023-10-25T14:30:00"
  const isoDate = p.transactionAt.replace(' ', 'T') + ':00'

  const { error } = await supabase
    .from('payments')
    .insert({
      transaction_date: isoDate,
      amount_eur: p.amountEUR,
      amount_local: p.amountLocal,
      manager_id: p.manager.id,
      product: p.product,
      country: p.country,
      payment_type: p.paymentType,
      crm_link: p.crmLink,
      screenshot_url: p.screenshotUrl,
      telegram_id: String(p.manager.telegramId),
      status: 'completed' // Сразу ставим статус completed
    })

  if (error) {
    console.error('Supabase insert error:', error)
    throw new Error('Ошибка записи в БД')
  }
  return true
}