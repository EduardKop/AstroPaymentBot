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
  return new Scenes.WizardScene(
    'paymentWizard',

    // 0. СТАРТ
    async (ctx) => {
      ctx.wizard.state.payment = {
        manager: ctx.state.manager, // Берется из глобального state при входе
        createdAt: new Date().toISOString()
      }
      await ctx.reply(
        '🚀 Новый платеж. Выбери продукт:', 
        Markup.inlineKeyboard(
          PRODUCTS.map(p => Markup.button.callback(p, `PROD_${p}`)), { columns: 2 }
        )
      )
      return ctx.wizard.next()
    },

    // 1. ВЫБОР ПРОДУКТА (Кнопки)
    async (ctx) => {
      // Если юзер ввел текст вместо кнопки/start, игнорируем или просим нажать кнопку
      if (!ctx.callbackQuery?.data) return 

      await ctx.answerCbQuery()
      const data = ctx.callbackQuery.data
      
      let rawName = data.replace('PROD_', '')
      // Чистим от эмодзи для БД
      let prodName = rawName.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()

      // Подмена для курсов
      if (rawName.includes('Курс (с куратором)')) prodName = 'Курс (куратор)'
      if (rawName.includes('Курс (без куратора)')) prodName = 'Курс'
      
      if (data.includes('Ничего не подходит')) {
        await ctx.reply('Напиши название продукта вручную:')
        return ctx.wizard.next()
      }

      ctx.wizard.state.payment.product = prodName
      await ctx.reply(`Выбран: ${prodName}\n\nВставь ссылку на Instagram клиента (https://www.instagram.com/Ник/):`)
      return ctx.wizard.selectStep(3) // Перепрыгиваем шаг ручного ввода
    },
    
    // 2. РУЧНОЙ ВВОД ПРОДУКТА (если выбрали "Ничего не подходит")
    async (ctx) => {
      if (!ctx.message?.text) return // Игнорируем не текст
      
      const text = ctx.message.text.trim()
      ctx.wizard.state.payment.product = text
      await ctx.reply('Вставь ссылку на Instagram клиента (https://www.instagram.com/Ник/):')
      return ctx.wizard.next()
    },

    // 3. ССЫЛКА И НИКНЕЙМ (С ПРОВЕРКОЙ)
    async (ctx) => {
      if (!ctx.message?.text) return 

      const text = ctx.message.text.trim()
      
      // 1. Простая проверка на URL
      if (!isValidUrl(text)) {
        return ctx.reply('⚠️ Это не ссылка. Отправь ссылку вида: https://www.instagram.com/username/')
      }

      // 2. Проверка домена
      if (!text.includes('instagram.com')) {
        return ctx.reply('❌ Ссылка должна быть на Instagram.')
      }

      // 3. Вытаскиваем никнейм
      const match = text.match(/instagram\.com\/([^/?#]+)/i)
      
      if (!match || !match[1]) {
        return ctx.reply('❌ Не могу найти никнейм в ссылке. Проверь формат.')
      }

      const username = match[1] // Чистый ник
      ctx.wizard.state.payment.crmLink = `@${username}` // Сохраняем как @username
      
      await ctx.reply(`✅ Клиент: @${username}\n\nТеперь пришли скриншот оплаты (фото или файл):`)
      return ctx.wizard.next()
    },

    // 4. СКРИНШОТ
    async (ctx) => {
      // Разрешаем фото или документ
      if (!ctx.message?.photo && !ctx.message?.document) {
        return ctx.reply('Нужно прислать картинку или файл скриншота.')
      }

      ctx.wizard.state.payment.screenshotUrl = 'Скриншот получен'
      
      const example = getNowExample()
      await ctx.reply(`✅ Скрин принят.\n\nВведи дату и время продажи (например: ${example}):`)
      return ctx.wizard.next()
    },

    // 5. ДАТА
    async (ctx) => {
      try {
        const t = ctx.message?.text || ''
        ctx.wizard.state.payment.transactionAt = parseDateTimeOrThrow(t)
      } catch {
        const example = getNowExample()
        return ctx.reply(`Неверный формат даты. Попробуй так: ${example}`)
      }

      // Определяем валюту по стране менеджера
      const mgr = ctx.wizard.state.payment.manager
      const { country, currency } = resolveCountry(mgr.countriesRaw)
      ctx.wizard.state.payment.country = country
      ctx.wizard.state.payment.currency = currency

      await ctx.reply(`Сумма оплаты в ${currency} (просто число):`)
      return ctx.wizard.next()
    },

    // 6. СУММА
    async (ctx) => {
      let val
      try { val = parseMoneyOrThrow(ctx.message?.text) } 
      catch { return ctx.reply('Пожалуйста, введи корректное число (например: 1500).') }

      const p = ctx.wizard.state.payment
      p.amountLocal = val
      p.amountEUR = await convertToEUR(val, p.currency)

      // Проверка на совпадение с тарифами (подсказка)
      if (p.amountEUR) {
        const check = isCloseToAnyProduct(p.amountEUR)
        if (!check.ok) {
           await ctx.reply(
             `⚠️ ${val} ${p.currency} ≈ ${p.amountEUR} EUR. Это не похоже на стандартный тариф. Верно?`,
             Markup.inlineKeyboard([
               Markup.button.callback('✅ Да, верно', 'AM_OK'),
               Markup.button.callback('✏️ Исправить', 'AM_EDIT')
             ])
           )
           return ctx.wizard.next()
        }
        p.productHint = check.productName
      }
      
      await askType(ctx)
      return ctx.wizard.selectStep(8)
    },

    // 7. ПОДТВЕРЖДЕНИЕ СУММЫ (если была странная)
    async (ctx) => {
      if (ctx.callbackQuery?.data === 'AM_EDIT') {
        await ctx.answerCbQuery()
        await ctx.reply('Введи правильную сумму:')
        return ctx.wizard.selectStep(6)
      }
      await ctx.answerCbQuery() // AM_OK
      await askType(ctx)
      return ctx.wizard.next()
    },

    // 8. ТИП ОПЛАТЫ
    async (ctx) => {
      if (!ctx.callbackQuery?.data) return
      await ctx.answerCbQuery()
      const t = ctx.callbackQuery.data.replace('TYPE_', '')
      
      if (t === 'Другое') {
        await ctx.reply('Напиши тип/кошелек вручную:')
        return ctx.wizard.next() 
      }

      ctx.wizard.state.payment.paymentType = t
      await showFinal(ctx)
      return ctx.wizard.selectStep(10)
    },

    // 9. ВВОД ТИПА ВРУЧНУЮ
    async (ctx) => {
      if (!ctx.message?.text) return
      ctx.wizard.state.payment.paymentType = ctx.message.text
      await showFinal(ctx)
      return ctx.wizard.next() 
    },

    // 10. ФИНАЛ И СОХРАНЕНИЕ
    async (ctx) => {
      const data = ctx.callbackQuery?.data
      if (data) await ctx.answerCbQuery().catch(() => {}) 

      if (data === 'CANCEL') {
        await ctx.reply('❌ Отменено. Жми /start чтобы начать заново.')
        return ctx.scene.leave()
      }

      if (data === 'SEND') {
        await ctx.reply('⏳ Сохраняю...')
        const p = ctx.wizard.state.payment

        try {
          // 1. Google Sheets
          await appendPaymentRow([
            new Date().toLocaleString('ru-RU'),
            p.manager.name,
            p.crmLink, // Тут уже лежит @username
            p.transactionAt,
            p.amountLocal,
            p.amountEUR,
            p.country,
            p.screenshotUrl,
            p.paymentType,
            p.product
          ])
          // 2. Supabase
          await insertPayment(p)
          
          await ctx.reply('✅ Успешно! Можешь вносить следующий платеж (/start).')
          return ctx.scene.leave()
        } catch (e) {
          console.error(e)
          await ctx.reply(`❌ Ошибка базы данных: ${e.message}`)
          // Не выходим из сцены, даем шанс нажать кнопку еще раз
        }
      }
    }
  )
}

function askType(ctx) {
  return ctx.reply('Куда пришли деньги?', Markup.inlineKeyboard(TYPES.map(t => [Markup.button.callback(t, `TYPE_${t}`)])))
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