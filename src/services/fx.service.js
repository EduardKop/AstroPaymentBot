import { getRatesEUR } from './rates.service.js'

const COUNTRY_TO_CURRENCY = {
  PL: 'PLN', RO: 'RON', DE: 'EUR', PT: 'EUR', IT: 'EUR', ES: 'EUR', UA: 'UAH', CZ: 'CZK'
}

export function resolveCountry(countriesRaw) {
  if (!countriesRaw) return { country: 'Other', currency: 'EUR' }
  
  const first = String(countriesRaw)
    .split(/[,|;]/)
    .map(s => s.trim().toUpperCase().replace(/[^A-Z]/g, ''))
    .filter(Boolean)[0]

  return { 
    country: first || 'Other', 
    currency: COUNTRY_TO_CURRENCY[first] || 'EUR' 
  }
}

export async function convertToEUR(amountLocal, currency) {
  if (!currency || currency === 'EUR') return amountLocal
  
  const rates = await getRatesEUR()
  const rate = rates[currency]
  
  if (!rate) return amountLocal
  
  return Math.round((amountLocal / rate + Number.EPSILON) * 100) / 100
}

export function isCloseToAnyProduct(eurAmount) {
  // <--- ДОБАВИЛИ НОВЫЕ ТАРИФЫ СЮДА
  const PRODUCTS = { 
    'Trial': 30, 
    'Standard': 59, 
    'Premium': 99,
    'Курс': 299,            // Новое
    'Курс (куратор)': 459   // Новое
  }
  const TOLERANCE = 2 // Допуск +- 2 евро (можно увеличить до 3-4, если скачет курс)

  for (const [name, price] of Object.entries(PRODUCTS)) {
    if (Math.abs(eurAmount - price) <= TOLERANCE) {
      return { ok: true, productName: name, priceEUR: price }
    }
  }
  return { ok: false }
}