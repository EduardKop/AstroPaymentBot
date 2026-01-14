import { Scenes, Markup } from 'telegraf'
import { resolveCountry, convertToEUR, isCloseToAnyProduct } from '../services/fx.service.js'
import { appendPaymentRow } from '../services/google.service.js'
import { insertPayment } from '../services/supabase.service.js'
import { parseDateTimeOrThrow, parseMoneyOrThrow, isValidUrl } from '../utils/validators.js'
import { formatSummary } from '../utils/format.js'

const PRODUCTS = [
  '❤️ Лич5', '❤️ Лич1', '💰 Финансы1', '💰 Финансы5', '🔮 Общий1', '🔮 Общий5',
  '👶 Дети', '🌀 Мандала лич', '🌀 Мандала фин', '🃏 ТАРО', '☀️ Соляр',
  '📅 Календарь', 
  '🎓 Курс (с куратором)', 
  '🎓 Курс (без куратора)', 
  '🚫 Ничего не подходит'
]
const TYPES = ['Lava', 'JETFEX', 'IBAN', 'Прямые реквизиты', 'Другое']

export function createPaymentWizard() {
  const wizard = new Scenes.WizardScene(
    'paymentWizard',

    // 0. Старт
    async (ctx) => {
      ctx.wizard.state.payment = {
        manager: ctx.state.manager,
        createdAt: new Date().toISOString()
      }
      await ctx.reply(
        'Выбери продукт (или введи /reset для отмены):', 
        Markup.inlineKeyboard(
          PRODUCTS.map(p => Markup.button.callback(p, `PROD_${p}`)), { columns: 2 }
        )
      )
      return ctx.wizard.next()
    },

    // 1. Выбор продукта
    async (ctx) => {
      if (!ctx.callbackQuery?.data) return
      await ctx.answerCbQuery()
      const data = ctx.callbackQuery.data
      
      let rawName = data.replace('PROD_', '')
      let prodName = rawName.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()

      if (rawName.includes('Курс (с куратором)')) prodName = 'Курс (куратор)'
      if (rawName.includes('Курс (без куратора)')) prodName = 'Курс'
      
      if (data.includes('Ничего не подходит')) {
        await ctx.reply('Напиши название продукта вручную:')
        return ctx.wizard.next()
      }

      ctx.wizard.state.payment.product = prodName
      await ctx.reply(`Выбран продукт: ${prodName}\n\nСсылка на клиента (https://www.instagram.com/Никнейм/):`)
      return ctx.wizard.selectStep(3)
    },
    
    // 2. Ручной ввод продукта
    async (ctx) => {
      const text = ctx.message?.text?.trim()
      if (!text) return ctx.reply('Введи текст.')
      ctx.wizard.state.payment.product = text
      await ctx.reply('Ссылка на клиента в инстаграм (полный URL https://www.instagram.com/Никнейм/ ):')
      return ctx.wizard.next()
    },

    // 3. CRM / Instagram Link (✅ ИЗВЛЕЧЕНИЕ НИКНЕЙМА)
    async (ctx) => {
      const text = ctx.message?.text?.trim()
      
      // 1. Проверяем, что это валидная ссылка
      if (!isValidUrl(text)) {
        return ctx.reply('⚠️ Это не похоже на ссылку. Ссылка должна начинаться с https://')
      }

      // 2. Проверяем, что это Instagram
      if (!text.includes('instagram.com')) {
        return ctx.reply('❌ Ссылка должна вести на Instagram (https://www.instagram.com/Никнейм/)')
      }

      // 3. Извлекаем никнейм
      // Ищем все символы после "instagram.com/" до следующего слэша, вопроса или конца строки
      const match = text.match(/instagram\.com\/([^/?#]+)/i)
      
      if (!match || !match[1]) {
        return ctx.reply('❌ Не удалось найти никнейм в ссылке. Проверь формат: https://www.instagram.com/username/')
      }

      const username = match[1] // Получаем чистый ник

      // Сохраняем в объект платежа (добавляем @ для ясности в базе/гугл таблице)
      ctx.wizard.state.payment.crmLink = `@${username}`
      
      await ctx.reply(`✅ Никнейм принят: @${username}\n\nПришли скриншот оплаты (фото или файл):`)
      return ctx.wizard.next()
    },

    // 4. Скриншот
    async (ctx) => {
      const hasPhoto = ctx.message?.photo?.length > 0
      const hasDoc = !!ctx.message?.document

      if (!hasPhoto && !hasDoc) {
        return ctx.reply('Пришли фото или файл.')
      }

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
             `${val} ${p.currency} ≈ ${p.amountEUR} EUR. Верно?`,
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
        await ctx.answerCbQuery()
        await ctx.reply('Введи сумму заново:')
        return ctx.wizard.selectStep(6)
      }
      await ctx.answerCbQuery()
      await askType(ctx)
      return ctx.wizard.next()
    },

    // 8. Тип оплаты
    async (ctx) => {
      if (!ctx.callbackQuery?.data) return
      await ctx.answerCbQuery()
      const t = ctx.callbackQuery.data.replace('TYPE_', '')
      
      if (t === 'Другое') {
        await ctx.reply('Напиши тип вручную:')
        return ctx.wizard.next() 
      }

      ctx.wizard.state.payment.paymentType = t
      await showFinal(ctx)
      return ctx.wizard.selectStep(10)
    },

    // 9. Ввод типа вручную
    async (ctx) => {
      if (!ctx.message?.text) return
      ctx.wizard.state.payment.paymentType = ctx.message.text
      await showFinal(ctx)
      return ctx.wizard.next() 
    },

    // 10. Финал
    async (ctx) => {
      const data = ctx.callbackQuery?.data
      if (data) await ctx.answerCbQuery().catch(() => {}) 

      if (data === 'CANCEL') {
        await ctx.reply('❌ Отменено.')
        return ctx.scene.leave()
      }

      if (data === 'SEND') {
        await ctx.reply('⏳ Сохраняю данные...')
        const p = ctx.wizard.state.payment

        try {
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
          await insertPayment(p)
          
          await ctx.reply('✅ Платеж успешно сохранен!')
          return ctx.scene.leave()
        } catch (e) {
          console.error(e)
          await ctx.reply(`❌ Ошибка сохранения: ${e.message}`)
        }
      }
    }
  )

  // 1. ОБРАБОТЧИК /start
  // Если нажать /start во время визарда — просто выходим (чтобы перезапустить бота)
  wizard.command('start', async (ctx) => {
    await ctx.scene.leave()
    await ctx.reply('🏠 Вы вышли из режима ввода. Нажмите /start или выберите команду меню.')
  })

  // 2. ОБРАБОТЧИК ОТМЕНЫ
  // Срабатывает на любом шаге
  wizard.command(['reset', 'cancel'], async (ctx) => {
    await ctx.reply('❌ Ввод данных отменен.')
    return ctx.scene.leave()
  })

  return wizard
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

function getNowExample() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}