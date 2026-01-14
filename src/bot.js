import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Telegraf, Scenes, session } from 'telegraf'
import { createPaymentWizard } from './scenes/paymentWizard.scene.js'
import { findManagerByTelegramIdInDB } from './services/supabase.service.js'

console.log('🚀 Запуск бота...')

// --- Google Auth File Setup ---
const secretsDir = path.resolve(process.cwd(), 'secrets')
const googleKeyPath = path.join(secretsDir, 'google-service-account.json')
if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir)
if (process.env.GOOGLE_JSON) {
  fs.writeFileSync(googleKeyPath, process.env.GOOGLE_JSON)
}
// ------------------------------

if (!process.env.BOT_TOKEN) throw new Error('Нет BOT_TOKEN')

const bot = new Telegraf(process.env.BOT_TOKEN)

// Подключаем сессии и сцены
bot.use(session())
const stage = new Scenes.Stage([createPaymentWizard()])
bot.use(stage.middleware())

// ГЛОБАЛЬНАЯ КОМАНДА /start
// Она работает всегда, даже если юзер застрял внутри сцены
bot.start(async (ctx) => {
  try {
    // 1. Принудительно выходим из любой текущей сцены, чтобы сбросить стейт
    if (ctx.scene) {
        await ctx.scene.leave()
    }

    // 2. Проверяем менеджера в базе
    const manager = await findManagerByTelegramIdInDB(ctx.from.id)
    if (!manager) {
      return ctx.reply('⛔ Нет доступа. Твоего ID нет в базе активных менеджеров.')
    }
    
    // 3. Сохраняем менеджера в сессию (чтобы сцена его увидела)
    ctx.state.manager = manager
    
    // 4. Запускаем сцену с нуля
    await ctx.scene.enter('paymentWizard')
    
  } catch (e) {
    console.error('Start error:', e)
    ctx.reply('Произошла ошибка при запуске. Попробуй позже.')
  }
})

// Глобальная отмена на всякий случай
bot.command('cancel', async (ctx) => {
    await ctx.scene.leave()
    ctx.reply('Сброшено. Жми /start')
})

bot.launch().then(() => console.log('✅ Бот работает!'))

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))