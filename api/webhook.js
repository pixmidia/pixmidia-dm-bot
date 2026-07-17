import { Redis } from '@upstash/redis'
import { GoogleGenerativeAI } from '@google/generative-ai'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const SYSTEM_PROMPT = `Você é a Bia, assistente virtual da Pix Mídia no Instagram.
A Pix Mídia desenvolve soluções de comunicação interna para empresas:
- ImidiaTV: TV corporativa que alcança 100% dos colaboradores (na fábrica, escritório, loja) sem aplicativo nem login
- ImidiaApp: app mobile de comunicação interna
- ImidiaWeb: intranet web completa

Seu objetivo é qualificar leads e agendar demonstrações.

Regras:
- Seja cordial, direta e profissional
- Nunca invente informações sobre preços (diga que depende do porte da empresa)
- Se perguntarem preço, ofereça agendar uma demo personalizada
- Se a pessoa demonstrar interesse real, peça: nome, empresa, cargo e email
- Mensagens curtas — máximo 3 parágrafos
- Nunca use markdown (sem asteriscos, sem listas com hífen)
- Se não souber responder, diga que vai passar para um consultor
- Se o usuário pedir falar com humano, diga que vai acionar o time e encerre com: [ESCALAR_HUMANO]`

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verificado com sucesso')
      return res.status(200).send(challenge)
    }
    return res.status(403).send('Forbidden')
  }

  if (req.method === 'POST') {
    const body = req.body

    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          if (event.message && !event.message.is_echo) {
            await handleMessage(event).catch(err =>
              console.error('Erro ao processar mensagem:', err)
            )
          }
        }
      }
    }

    return res.status(200).json({ status: 'ok' })
  }

  return res.status(405).send('Method Not Allowed')
}

async function handleMessage(event) {
  const senderId = event.sender.id
  const messageText = event.message?.text

  if (!messageText) return

  const historyKey = `conv:${senderId}`
  const raw = await redis.get(historyKey)
  const history = Array.isArray(raw) ? raw : []

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  })

  const chat = model.startChat({ history })

  const result = await chat.sendMessage(messageText)
  const reply = result.response.text()

  const updated = [
    ...history,
    { role: 'user', parts: [{ text: messageText }] },
    { role: 'model', parts: [{ text: reply }] },
  ].slice(-30)

  await redis.set(historyKey, updated, { ex: 86400 })

  const textToSend = reply.replace('[ESCALAR_HUMANO]', '').trim()
  await sendInstagramMessage(senderId, textToSend)

  if (reply.includes('[ESCALAR_HUMANO]')) {
    console.log(`[ESCALAR] Usuário ${senderId} pediu atendimento humano`)
  }
}

async function sendInstagramMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    console.error('Erro ao enviar mensagem Instagram:', JSON.stringify(err))
  }
}
