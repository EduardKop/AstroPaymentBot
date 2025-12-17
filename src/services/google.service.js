import fs from 'node:fs'
import path from 'node:path'
import { google } from 'googleapis'
import PQueue from 'p-queue'

// Очередь для защиты от лимитов (1 запрос одновременно)
const queue = new PQueue({ concurrency: 1 })

// --- AUTH ---
async function getAuthClient(scopes) {
  const secretsPath = path.resolve(process.cwd(), 'secrets/google-service-account.json')
  
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`Файл ключей не найден: ${secretsPath}`)
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: secretsPath,
    scopes: scopes
  })
  return auth.getClient()
}

// --- SHEETS (Append) ---
export async function appendPaymentRow(row) {
  return queue.add(async () => {
    const auth = await getAuthClient(['https://www.googleapis.com/auth/spreadsheets'])
    const sheets = google.sheets({ version: 'v4', auth })
    const spreadsheetId = process.env.GOOGLE_SHEET_ID

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Платежи!A:J', // Имя листа "Платежи"
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    })
  })
}