import fs from 'node:fs'
import path from 'node:path'
import { google } from 'googleapis'
import { Readable } from 'node:stream'
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

// --- DRIVE (Upload) ---
function bufferToStream(buffer) {
  const stream = new Readable()
  stream.push(buffer)
  stream.push(null)
  return stream
}

export async function uploadTelegramFileToDrive(ctx) {
  const auth = await getAuthClient(['https://www.googleapis.com/auth/drive'])
  const drive = google.drive({ version: 'v3', auth })
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  // 1. Скачиваем файл из Телеграма
  const photo = ctx.message?.photo?.at(-1)
  const doc = ctx.message?.document
  const fileId = photo?.file_id || doc?.file_id
  
  if (!fileId) throw new Error('No file found')

  const link = await ctx.telegram.getFileLink(fileId)
  const response = await fetch(link.href)
  const buffer = Buffer.from(await response.arrayBuffer())

  // 2. Имя файла
  const ext = doc?.file_name?.split('.').pop() || (photo ? 'jpg' : 'bin')
  const filename = `pay_${ctx.from.id}_${Date.now()}.${ext}`

  // 3. Загружаем на Диск
  const fileMetadata = {
    name: filename,
    parents: [folderId]
  }
  const media = {
    mimeType: doc?.mime_type || (photo ? 'image/jpeg' : 'application/octet-stream'),
    body: bufferToStream(buffer)
  }

  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, webViewLink'
  })

  const uploadedFileId = file.data.id

  // 4. Делаем публичным (чтобы все видели скриншот)
  await drive.permissions.create({
    fileId: uploadedFileId,
    requestBody: { role: 'reader', type: 'anyone' }
  })

  return file.data.webViewLink
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