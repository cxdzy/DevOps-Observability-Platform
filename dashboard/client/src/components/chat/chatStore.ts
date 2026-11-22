// The Chat view's chats: an array in browser memory only (no localStorage, no server storage), so a
// reload clears them. Each chat keeps its own messages, follow-up context, draft, scroll position
// and pending state; only the active chat's context goes with a request from that chat.
// Plain TypeScript with no Vue import, so server/test can run it under node --test. The view
// passes Vue's reactive() as wrap.

export const MAX_CHATS = 8
export const TITLE_CHARS = 40
export const RENAME_CHARS = 60
export const NEW_TITLE = 'New chat'
export const LIMIT_REASON = `You have ${MAX_CHATS} chats open, the most this page keeps. Delete one to start a new chat.`
export const CAUSE_QUESTION = 'What caused it?'
export const CAUSE_QUESTION_MS = 'Apa punca dia?'
// The server parser's MALAY_WORDS (server/chat/parser.js); a test checks the two lists match. One
// of these words marks a Malay message, as on the server.
export const MALAY_WORDS = ['ada', 'apa', 'bila', 'berapa', 'dalam', 'jam', 'lepas', 'tak', 'tidak', 'adakah', 'kenapa',
  'mengapa', 'bagaimana', 'sekarang', 'memori', 'untuk', 'yang', 'ini', 'itu', 'saya', 'boleh', 'insiden', 'cuaca',
  'rangkaian', 'masuk', 'sistem', 'risau', 'masalah', 'semalam', 'hari', 'kah', 'tolong', 'jangan', 'payah', 'hentikan', 'semula',
  'ia', 'dia', 'mana', 'punca', 'puncak', 'setinggi', 'teruk', 'naik', 'pukul']
const NO_ANSWER = 'The assistant did not answer. Nothing was changed.'
const QUEUE_FULL = 'The assistant is busy with other questions. Your text is back in the input. Try again in a minute.'
const MODEL_DOWN = 'The local model did not answer. Nothing was changed.'
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

export interface IncidentRef { start: string, tier: string, signal: string }
export interface ChatContext {
  last_incident: IncidentRef | null
  last_intent: string | null
  last_window_h: number
  shown: string[]
}
export interface ReplyChip { start: number, tier: string | null, signal?: string | null, choice?: boolean }
export type ReplyKind = 'template' | 'guard' | 'llm' | 'fallback' | 'action_unavailable'
export interface ChatReply {
  kind: ReplyKind
  answer: string
  incidents: ReplyChip[]
  sources: string[]
  elapsed_s: number
  model: string | null
  context?: ChatContext | null
}
export type NoticeKind = 'hourly_limit' | 'queue_full' | 'model_down'

// One line of a conversation.
export interface ChatEntry {
  id: number
  role: 'user' | 'assistant'
  text: string
  kind?: ReplyKind
  sources?: string[]
  elapsedS?: number
  incidents?: ReplyChip[]
  // A notice in the conversation instead of an answer.
  notice?: NoticeKind
  // The request failed for another reason; text is shown as an error.
  error?: boolean
}

export interface Chat {
  id: number
  title: string
  renamed: boolean
  messages: ChatEntry[]
  context: ChatContext | null
  draft: string
  scrollTop: number
  // Set while a request from this chat is waiting; since is the time it was sent.
  pending: { since: number } | null
  lastAt: number | null
}

// What a failed post gives the store: the HTTP status (0 when there was none) and the JSON body.
export interface PostError { status: number, data: unknown, retryAfter?: string | null }
export type Post = (message: string, context: ChatContext | null) => Promise<ChatReply>
export type Wrap = <T extends object>(value: T) => T

export function isPostError(value: unknown): value is PostError {
  return typeof value === 'object' && value !== null && typeof (value as PostError).status === 'number'
}

// HH:MM in MYT (UTC+8), whatever the browser's time zone.
export function mytClock(ms: number): string {
  const d = new Date(ms + MYT_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// The hourly-limit line, with the next free time when the server sent one.
export function hourlyLimitText(nextFreeAt: unknown): string {
  const ms = typeof nextFreeAt === 'string' ? Date.parse(nextFreeAt) : Number.NaN
  if (!Number.isFinite(ms)) return 'You have used all your questions for this hour. Try again later this hour.'
  return `You have used all your questions for this hour. The next one is free at ${mytClock(ms)} MYT.`
}

// True when the text has one of MALAY_WORDS, split into words the same way as the server parser.
export function isMalay(text: string): boolean {
  const clean = text.toLowerCase().replace(/[‘’]/g, "'")
  return clean.split(/[^\p{L}\p{N}'/-]+/u).some(w => MALAY_WORDS.includes(w))
}

// The cause question a choice chip sends: Malay after a Malay question in this chat, else English.
export function causeQuestionFor(chat: Chat): string {
  const lastUser = [...chat.messages].reverse().find(m => m.role === 'user')
  return lastUser && isMalay(lastUser.text) ? CAUSE_QUESTION_MS : CAUSE_QUESTION
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > TITLE_CHARS ? clean.slice(0, TITLE_CHARS) : clean
}

export function createChatStore(options: { post: Post, now?: () => number, wrap?: Wrap }) {
  const now = options.now ?? Date.now
  const wrap: Wrap = options.wrap ?? (<T extends object>(v: T) => v)
  let nextChatId = 1
  let nextEntryId = 1

  function blank(): Chat {
    return { id: nextChatId++, title: NEW_TITLE, renamed: false, messages: [], context: null, draft: '', scrollTop: 0, pending: null, lastAt: null }
  }

  const first = blank()
  const state = wrap({ chats: [first] as Chat[], activeId: first.id })

  function find(id: number): Chat | undefined {
    return state.chats.find(c => c.id === id)
  }

  function active(): Chat {
    return find(state.activeId) ?? state.chats[0]
  }

  function canCreate(): boolean {
    return state.chats.length < MAX_CHATS
  }

  // Opens a new empty chat. Returns false (and changes nothing) at the limit.
  function newChat(): boolean {
    if (!canCreate()) return false
    const chat = blank()
    state.chats.unshift(chat)
    state.activeId = chat.id
    return true
  }

  function select(id: number) {
    if (find(id)) state.activeId = id
  }

  // Deletes a chat. Deleting the active chat moves to the next chat in the list (or the one
  // before it at the end); deleting the last chat opens a new empty one.
  function remove(id: number) {
    const i = state.chats.findIndex(c => c.id === id)
    if (i < 0) return
    const wasActive = state.activeId === id
    state.chats.splice(i, 1)
    if (state.chats.length === 0) {
      const chat = blank()
      state.chats.push(chat)
      state.activeId = chat.id
      return
    }
    if (wasActive) state.activeId = state.chats[Math.min(i, state.chats.length - 1)].id
  }

  // Renames a chat to at most RENAME_CHARS characters. An empty name changes nothing.
  function rename(id: number, title: string): boolean {
    const chat = find(id)
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, RENAME_CHARS)
    if (!chat || !clean) return false
    chat.title = clean
    chat.renamed = true
    return true
  }

  function clearContext(id: number = state.activeId) {
    const chat = find(id)
    if (chat) chat.context = null
  }

  // The other chat waiting for a reply, for the busy line: the one that has waited longest.
  function busyFor(id: number): { chatId: number, title: string, seconds: number } | null {
    let other: Chat | null = null
    for (const c of state.chats) {
      if (c.id !== id && c.pending && (!other || c.pending.since < other.pending!.since)) other = c
    }
    if (!other || !other.pending) return null
    return { chatId: other.id, title: other.title, seconds: Math.max(0, Math.floor((now() - other.pending.since) / 1000)) }
  }

  // True while this chat's question waits behind one sent earlier from another chat.
  function waitingBehind(id: number): boolean {
    const chat = find(id)
    if (!chat || !chat.pending) return false
    const since = chat.pending.since
    return state.chats.some(c => c.id !== id && c.pending !== null && c.pending.since <= since)
  }

  function push(chat: Chat, entry: Omit<ChatEntry, 'id'>) {
    chat.messages.push({ id: nextEntryId++, ...entry })
    chat.lastAt = now()
  }

  // Sends a question from a chat (the active one by default) with that chat's own context.
  async function send(text: string, id: number = state.activeId): Promise<void> {
    const chat = find(id)
    const message = text.trim()
    if (!chat || !message || chat.pending) return
    const titleBefore = chat.title
    if (!chat.renamed && chat.messages.every(m => m.role !== 'user')) chat.title = titleFrom(message)
    push(chat, { role: 'user', text: message })
    const userEntryId = chat.messages[chat.messages.length - 1].id
    chat.draft = ''
    chat.pending = { since: now() }
    const context = chat.context
    try {
      const data = await options.post(message, context)
      const target = find(id)
      if (!target) return
      push(target, {
        role: 'assistant',
        text: data.answer,
        kind: data.kind,
        sources: data.sources,
        elapsedS: data.elapsed_s,
        incidents: data.incidents,
      })
      if (data.context !== undefined) target.context = data.context
    } catch (err) {
      const target = find(id)
      if (!target) return
      failed(target, err, message, userEntryId, titleBefore)
    } finally {
      const target = find(id)
      if (target) target.pending = null
    }
  }

  function failed(chat: Chat, err: unknown, message: string, userEntryId: number, titleBefore: string) {
    const status = isPostError(err) ? err.status : 0
    const body = isPostError(err) && typeof err.data === 'object' && err.data !== null ? err.data as Record<string, unknown> : {}
    if (status === 429 && body.code === 'hourly_limit') {
      push(chat, { role: 'assistant', text: hourlyLimitText(body.next_free_at), notice: 'hourly_limit' })
    } else if (status === 429) {
      // Queue full: the question was not taken, so it goes back into the input.
      chat.messages = chat.messages.filter(m => m.id !== userEntryId)
      if (!chat.renamed) chat.title = titleBefore
      chat.draft = message
      push(chat, { role: 'assistant', text: QUEUE_FULL, notice: 'queue_full' })
    } else if (status === 503) {
      push(chat, { role: 'assistant', text: MODEL_DOWN, notice: 'model_down' })
    } else {
      const text = status === 400 && typeof body.error === 'string' ? body.error : NO_ANSWER
      push(chat, { role: 'assistant', text, error: true })
    }
  }

  // An incident choice chip: that incident becomes the context and the cause is asked, in the
  // language of the chat's last question.
  function chooseIncident(chip: ReplyChip, id: number = state.activeId): Promise<void> {
    const chat = find(id)
    if (!chat || chat.pending) return Promise.resolve()
    const question = causeQuestionFor(chat)
    const base: ChatContext = chat.context ?? { last_incident: null, last_intent: null, last_window_h: 6, shown: [] }
    chat.context = {
      ...base,
      last_incident: { start: new Date(chip.start).toISOString(), tier: chip.tier ?? 'none', signal: chip.signal ?? 'unclear' },
      last_intent: 'cause',
    }
    return send(question, id)
  }

  return { state, active, find, canCreate, newChat, select, remove, rename, clearContext, busyFor, waitingBehind, send, chooseIncident }
}

export type ChatStore = ReturnType<typeof createChatStore>
