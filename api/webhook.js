import Groq from 'groq-sdk'
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const SYSTEM_PROMPT = `Você é a Bia, assistente virtual da Pix Mídia no Instagram.
A Pix Mídia desenvolve soluções de comunicação interna para empresas:
- ImidiaTV: TV corporativa que alcança 100% dos colaboradores (na fábrica, escritório, loja) sem aplicativo nem login
- ImidiaApp: app mobile de comunicação interna
- ImidiaWeb: intranet web completa

Seu objetivo é qualificar leads e agendar demonstrações.

Regras:
- Seja cordial, direta e profissional
- NUNCA informe valores ou preços — diga sempre que depende do porte e tipo da empresa e ofereça agendar uma demonstração gratuita ou falar com um consultor
- Se a pessoa demonstrar interesse real, colete obrigatoriamente: nome completo, empresa, cargo, email e telefone
- Mensagens curtas — máximo 3 parágrafos
- Nunca use markdown (sem asteriscos, sem listas com hífen)
- Se não souber responder, diga que vai passar para um consultor
- Se o usuário pedir falar com humano, diga que vai acionar o time e encerre com: [ESCALAR_HUMANO]

Quando tiver coletado TODOS os 5 dados (nome completo, empresa, cargo, email e telefone):
- Se a pessoa quiser agendar uma demonstração: responda normalmente e adicione [LEAD:MQL] ao final
- Se a pessoa quiser apenas mais informações ou ser contactada depois: responda normalmente e adicione [LEAD:NURTURE] ao final`

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
  const leadKey = `lead:${senderId}`

  const [raw, alreadyRegistered] = await Promise.all([
    redis.get(historyKey),
    redis.get(leadKey),
  ])
  let history = []
  if (Array.isArray(raw) && raw.length > 0 && raw[0].content) {
    history = raw
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: messageText },
  ]

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: 500,
  })

  const reply = completion.choices[0].message.content

  const updated = [
    ...history,
    { role: 'user', content: messageText },
    { role: 'assistant', content: reply },
  ].slice(-30)

  await redis.set(historyKey, updated, { ex: 86400 })

  const isMQL = reply.includes('[LEAD:MQL]')
  const isNurture = reply.includes('[LEAD:NURTURE]')
  const isEscalar = reply.includes('[ESCALAR_HUMANO]')

  const textToSend = reply
    .replace('[LEAD:MQL]', '')
    .replace('[LEAD:NURTURE]', '')
    .replace('[ESCALAR_HUMANO]', '')
    .trim()

  await sendInstagramMessage(senderId, textToSend)

  if (isEscalar) {
    console.log(`[ESCALAR] Usuário ${senderId} pediu atendimento humano`)
  }

  if ((isMQL || isNurture) && !alreadyRegistered) {
    const lifecyclestage = isMQL ? 'marketingqualifiedlead' : 'lead'
    const leadData = await extractLeadData(updated)
    if (leadData && leadData.email) {
      await upsertHubSpotContact(leadData, lifecyclestage)
      await redis.set(leadKey, lifecyclestage, { ex: 604800 })
      console.log(`[HUBSPOT] Lead registrado: ${leadData.email} (${lifecyclestage})`)
    }
  }
}

async function extractLeadData(history) {
  const prompt = `Analise a conversa acima e extraia os dados do lead. Retorne SOMENTE um JSON válido, sem texto adicional:
{"nome": "", "email": "", "telefone": "", "empresa": "", "cargo": ""}
Se algum campo não foi mencionado na conversa, use null.`

  try {
    const result = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        ...history,
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
    })
    const content = result.choices[0].message.content.trim()
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null
  } catch {
    return null
  }
}

async function upsertHubSpotContact(data, lifecyclestage) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN
  const api = 'https://api.hubapi.com'

  const nameParts = (data.nome || '').trim().split(' ')
  const firstName = nameParts[0] || ''
  const lastName = nameParts.slice(1).join(' ') || ''

  const properties = {
    firstname: firstName,
    lastname: lastName,
    email: data.email,
    phone: data.telefone || '',
    company: data.empresa || '',
    jobtitle: data.cargo || '',
    lifecyclestage,
    hs_analytics_source: 'SOCIAL_MEDIA',
    hs_analytics_source_data_1: 'pixmidia-dm-bot',
  }

  const searchRes = await fetch(`${api}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: data.email,
        }],
      }],
      properties: ['email'],
      limit: 1,
    }),
  })

  const searchData = await searchRes.json()
  const existingId = searchData.results?.[0]?.id

  if (existingId) {
    await fetch(`${api}/crm/v3/objects/contacts/${existingId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    })
    console.log(`[HUBSPOT] Contato atualizado: ${data.email} (id: ${existingId})`)
  } else {
    const createRes = await fetch(`${api}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    })
    const created = await createRes.json()
    console.log(`[HUBSPOT] Contato criado: ${data.email} (id: ${created.id}, ${lifecyclestage})`)
  }
}

async function sendInstagramMessage(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/17841440227491398/messages?access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`

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
