import { Scenes, Markup } from 'telegraf'
import { resolveCountry, convertToEUR, isCloseToAnyProduct } from '../services/fx.service.js'
import { appendPaymentRow } from '../services/google.service.js' // Убрали uploadTelegramFileToDrive
import { insertPayment } from '../services/supabase.service.js'
import { parseDateTimeOrThrow, parseMoneyOrThrow, isValidUrl } from '../utils/validators.js'
import { formatSummary } from '../utils/format.js'

const PRODUCTS = [
  '❤️ Лич5', '❤️ Лич1', '💰 Финансы1', '💰 Финансы5', '🔮 Общий1', '🔮 Общий5',
  '👶 Дети', '🌀 Мандала лич', '🌀 Мандала фин', '🃏 ТАРО', '☀️ Соляр',
  '📅 Календарь', '🚫 Ничего не подходит'
]
const TYPES = ['Lava', 'JETFEX', 'IBAN', 'Прямые реквизиты', 'Другое']

export function createPaymentWizard() {
  return new Scenes.WizardScene(
    'paymentWizard',

    // 0. Старт
    async (ctx) => {
      ctx.wizard.state.payment = {
        manager: ctx.state.manager,
        createdAt: new Date().toISOString()
      }
      await ctx.reply('Выбери продукт:', Markup.inlineKeyboard(
        PRODUCTS.map(p => [Markup.button.callback(p, `PROD_${p}`)])
      ))
      return ctx.wizard.next()
    },

    // 1. Выбор продукта
    async (ctx) => {
      if (!ctx.callbackQuery?.data) return
      const data = ctx.callbackQuery.data
      await ctx.answerCbQuery()
      
      const prodName = data.replace('PROD_', '').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()
      
      if (data.includes('Ничего не подходит')) {
        await ctx.reply('Напиши название продукта вручную:')
        return ctx.wizard.next()
      }

      ctx.wizard.state.payment.product = prodName
      await ctx.reply('Ссылка на клиента в CRM (полный URL):')
      return ctx.wizard.selectStep(3)
    },

    // 2. Ручной ввод продукта
    async (ctx) => {
      const text = ctx.message?.text?.trim()
      if (!text) return ctx.reply('Введи текст.')
      ctx.wizard.state.payment.product = text
      await ctx.reply('Ссылка на клиента в CRM (полный URL):')
      return ctx.wizard.next()
    },

    // 3. CRM
    async (ctx) => {
      const text = ctx.message?.text?.trim()
      if (!isValidUrl(text)) return ctx.reply('Нужна валидная ссылка (https://...)')
      
      ctx.wizard.state.payment.crmLink = text
      await ctx.reply('Пришли скриншот оплаты (фото или файл):')
      return ctx.wizard.next()
    },

    // 4. Скриншот (ЗАГЛУШКА)
    async (ctx) => {
      const hasPhoto = ctx.message?.photo?.length > 0
      const hasDoc = !!ctx.message?.document

      if (!hasPhoto && !hasDoc) {
        return ctx.reply('Пришли фото или файл.')
      }

      // Вместо загрузки просто ставим пометку
      ctx.wizard.state.payment.screenshotUrl = 'Скриншот получен (файл не сохранен)'
      
      await ctx.reply('✅ Скриншот принят.')

      const example = getNowExample()
      await ctx.reply(`Дата и время транзакции (например: ${example}):`)
      return ctx.wizard.next()
    },

    // 5. Дата
    async (ctx) => {
      try {
        const t = ctx.message?.text || ''
        ctx.wizard.state.payment.transactionAt = parseDateTimeOrThrow(t)
      } catch {
        const example = getNowExample()
        return ctx.reply(`Неверный формат. Нужно YYYY-MM-DD HH:mm (например: ${example})`)
      }

      const mgr = ctx.wizard.state.payment.manager
      const { country, currency } = resolveCountry(mgr.countriesRaw)
      ctx.wizard.state.payment.country = country
      ctx.wizard.state.payment.currency = currency

      await ctx.reply(`Сумма оплаты в ${currency} (только число):`)
      return ctx.wizard.next()
    },

    // 6. Сумма
    async (ctx) => {
      let val
      try { val = parseMoneyOrThrow(ctx.message?.text) } 
      catch { return ctx.reply('Введи корректное число.') }

      const p = ctx.wizard.state.payment
      p.amountLocal = val
      p.amountEUR = await convertToEUR(val, p.currency)

      if (p.amountEUR) {
        const check = isCloseToAnyProduct(p.amountEUR)
        if (!check.ok) {
           await ctx.reply(
             `⚠️ ${val} ${p.currency} ≈ ${p.amountEUR} EUR. Не похоже на стандартный тариф. Верно?`,
             Markup.inlineKeyboard([
               Markup.button.callback('✅ Да', 'AM_OK'),
               Markup.button.callback('✏️ Нет', 'AM_EDIT')
             ])
           )
           return ctx.wizard.next()
        }
        p.productHint = check.productName
      }
      
      await askType(ctx)
      return ctx.wizard.selectStep(8)
    },

    // 7. Подтверждение суммы
    async (ctx) => {
      if (ctx.callbackQuery?.data === 'AM_EDIT') {
        await ctx.reply('Введи сумму заново:')
        return ctx.wizard.selectStep(6)
      }
      await askType(ctx)
      return ctx.wizard.next()
    },

    // 8. Тип оплаты
    async (ctx) => {
      if (!ctx.callbackQuery?.data) return
      const t = ctx.callbackQuery.data.replace('TYPE_', '')
      if (t === 'Другое') {
        await ctx.reply('Напиши тип вручную:')
        return ctx.wizard.next()
      }
      ctx.wizard.state.payment.paymentType = t
      return showFinal(ctx)
    },

    // 9. Ввод типа вручную
    async (ctx) => {
      if (!ctx.message?.text) return
      ctx.wizard.state.payment.paymentType = ctx.message.text
      return showFinal(ctx)
    },

    // 10. Финал
    async (ctx) => {
      const data = ctx.callbackQuery?.data
      if (data === 'CANCEL') {
        await ctx.reply('Отменено.')
        return ctx.scene.leave()
      }
      if (data === 'SEND') {
        await ctx.reply('⏳ Сохраняю данные...')
        const p = ctx.wizard.state.payment
        try {
          // 1. В таблицу
          await appendPaymentRow([
            new Date().toLocaleString('ru-RU'),
            p.manager.name,
            p.crmLink,
            p.transactionAt,
            p.amountLocal,
            p.amountEUR,
            p.country,
            p.screenshotUrl,
            p.paymentType,
            p.product
          ])
          // 2. В Supabase
          await insertPayment(p)
          
          await ctx.reply('✅ Платеж успешно сохранен!')
        } catch (e) {
          console.error(e)
          await ctx.reply('❌ Ошибка сохранения. Свяжись с админом.')
        }
        return ctx.scene.leave()
      }
    }
  )
}

function askType(ctx) {
  return ctx.reply('Тип платежа:', Markup.inlineKeyboard(TYPES.map(t => [Markup.button.callback(t, `TYPE_${t}`)])))
}

function showFinal(ctx) {
  return ctx.reply(formatSummary(ctx.wizard.state.payment), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Отправить', 'SEND')],
      [Markup.button.callback('❌ Отмена', 'CANCEL')]
    ])
  })
}

// Хелпер для даты
function getNowExample() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}