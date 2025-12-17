import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Telegraf, Scenes, session } from 'telegraf'
import { createPaymentWizard } from './scenes/paymentWizard.scene.js'
import { findManagerByTelegramIdInDB } from './services/supabase.service.js'

console.log('🚀 Запуск бота платежей...')

// --- ВАЖНО: Создаем файл ключей Google из переменной окружения ---
const secretsDir = path.resolve(process.cwd(), 'secrets')
const googleKeyPath = path.join(secretsDir, 'google-service-account.json')

if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir)

if (process.env.GOOGLE_JSON) {
  console.log('⚙️ Создаю google-service-account.json из переменной окружения...')
  fs.writeFileSync(googleKeyPath, process.env.GOOGLE_JSON)
}
// ---------------------------------------------------------------

if (!process.env.BOT_TOKEN) throw new Error('Нет BOT_TOKEN')

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.use(session())

// Сцена
const stage = new Scenes.Stage([createPaymentWizard()])
bot.use(stage.middleware())

// Команда /start
bot.start(async (ctx) => {
  try {
    const manager = await findManagerByTelegramIdInDB(ctx.from.id)
    if (!manager) {
      return ctx.reply('⛔ Доступ запрещен. Тебя нет в базе менеджеров или ты не активен.')
    }
    
    // Сохраняем менеджера в сессию, чтобы сцена его видела
    ctx.state.manager = manager
    await ctx.scene.enter('paymentWizard')
    
  } catch (e) {
    console.error('Start error:', e)
    ctx.reply('Ошибка сервера.')
  }
})

bot.command('cancel', async (ctx) => {
  await ctx.scene.leave()
  ctx.reply('Действие отменено.')
})

bot.launch().then(() => console.log('✅ Бот работает!'))

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))