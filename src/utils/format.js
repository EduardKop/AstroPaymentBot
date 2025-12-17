export function formatSummary(p) {
  return [
    '📋 <b>Проверь данные:</b>',
    `• <b>Менеджер:</b> ${p.manager.name}`,
    `• <b>Страна:</b> ${p.country}`,
    `• <b>CRM:</b> ${p.crmLink}`,
    `• <b>Скриншот:</b> ${p.screenshotUrl === 'UPLOAD_FAILED' ? '❌ Ошибка загрузки' : `<a href="${p.screenshotUrl}">Ссылка</a>`}`,
    `• <b>Дата:</b> ${p.transactionAt}`,
    `• <b>Сумма:</b> ${p.amountLocal} ${p.currency} (~${p.amountEUR} EUR)`,
    p.productHint ? `• <i>Похоже на: ${p.productHint}</i>` : null,
    `• <b>Тип:</b> ${p.paymentType}`,
    `• <b>Продукт:</b> ${p.product}`
  ].filter(Boolean).join('\n')
}