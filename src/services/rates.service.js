let cache = { updatedAt: null, rates: {} }
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 часа

export async function getRatesEUR() {
  const now = Date.now()
  if (cache.updatedAt && now - cache.updatedAt < CACHE_TTL) {
    return cache.rates
  }

  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=PLN,RON,CZK')
    if (!res.ok) throw new Error('Rates API error')
    const data = await res.json()
    cache = { updatedAt: now, rates: data.rates }
    return cache.rates
  } catch (e) {
    console.error('FX Error, using fallback:', e)
    // Заглушка, если API упал
    return { PLN: 4.30, RON: 4.97, CZK: 25.3 } 
  }
}