import { ConfigService } from './config'
import { chatService, type ChatSession, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { httpService } from './httpService'

interface SessionBaseline {
  lastTimestamp: number
  unreadCount: number
  summary: string
  lastMsgType: number
}

type MessagePushEventName = 'message.new' | 'message.revoke' | 'group.invite'

interface MessagePushPayload {
  event: MessagePushEventName
  sessionId: string
  sessionType: 'private' | 'group' | 'official' | 'other'
  messageKey: string
  localType: number
  createTime: number
  avatarUrl?: string
  sourceName: string
  groupName?: string
  content: string | null
}

const PUSH_CONFIG_KEYS = new Set([
  'messagePushEnabled',
  'messagePushFilterMode',
  'messagePushFilterList',
  'dbPath',
  'decryptKey',
  'myWxid'
])

class MessagePushService {
  private readonly configService: ConfigService
  private readonly sessionBaseline = new Map<string, SessionBaseline>()
  private readonly recentMessageKeys = new Map<string, number>()
  private readonly groupNicknameCache = new Map<string, { nicknames: Record<string, string>; updatedAt: number }>()
  private readonly debounceMs = 350
  private readonly recentMessageTtlMs = 10 * 60 * 1000
  private readonly groupNicknameCacheTtlMs = 5 * 60 * 1000
  private readonly systemEventLookbackSec = 10 * 60
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private processing = false
  private rerunRequested = false
  private started = false
  private baselineReady = false
  private messageTableScanRequested = false
  private systemScanRequested = false

  constructor() {
    this.configService = ConfigService.getInstance()
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  handleDbMonitorChange(type: string, json: string): void {
    if (!this.started) return
    if (!this.isPushEnabled()) return

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(json)
    } catch {
      payload = null
    }

    const tableName = String(payload?.table || '').trim()
    if (this.isSessionTableChange(tableName)) {
      this.scheduleSync()
      return
    }

    if (!tableName || this.isMessageTableChange(tableName)) {
      this.scheduleSync({ scanMessageBackedSessions: true, scanSystemEvents: true })
    }
  }

  async handleConfigChanged(key: string): Promise<void> {
    if (!PUSH_CONFIG_KEYS.has(String(key || '').trim())) return
    if (key === 'dbPath' || key === 'decryptKey' || key === 'myWxid') {
      this.resetRuntimeState()
      chatService.close()
    }
    await this.refreshConfiguration(`config:${key}`)
  }

  handleConfigCleared(): void {
    this.resetRuntimeState()
    chatService.close()
  }

  private isPushEnabled(): boolean {
    return this.configService.get('messagePushEnabled') === true
  }

  private resetRuntimeState(): void {
    this.sessionBaseline.clear()
    this.recentMessageKeys.clear()
    this.groupNicknameCache.clear()
    this.baselineReady = false
    this.messageTableScanRequested = false
    this.systemScanRequested = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private async refreshConfiguration(reason: string): Promise<void> {
    if (!this.isPushEnabled()) {
      this.resetRuntimeState()
      return
    }

    const connectResult = await chatService.connect()
    if (!connectResult.success) {
      console.warn(`[MessagePushService] Bootstrap connect failed (${reason}):`, connectResult.error)
      return
    }

    await this.bootstrapBaseline()
  }

  private async bootstrapBaseline(): Promise<void> {
    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      return
    }
    this.setBaseline(sessionsResult.sessions as ChatSession[])
    this.baselineReady = true
  }

  private scheduleSync(options: { scanMessageBackedSessions?: boolean; scanSystemEvents?: boolean } = {}): void {
    if (options.scanMessageBackedSessions) {
      this.messageTableScanRequested = true
    }
    if (options.scanSystemEvents) {
      this.systemScanRequested = true
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flushPendingChanges()
    }, this.debounceMs)
  }

  private async flushPendingChanges(): Promise<void> {
    if (this.processing) {
      this.rerunRequested = true
      return
    }

    this.processing = true
    try {
      if (!this.isPushEnabled()) return
      const scanMessageBackedSessions = this.messageTableScanRequested
      const forceSystemScan = this.systemScanRequested
      this.messageTableScanRequested = false
      this.systemScanRequested = false

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        console.warn('[MessagePushService] Sync connect failed:', connectResult.error)
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return
      }

      const sessions = sessionsResult.sessions as ChatSession[]
      if (!this.baselineReady) {
        this.setBaseline(sessions)
        this.baselineReady = true
        return
      }

      const previousBaseline = new Map(this.sessionBaseline)
      this.setBaseline(sessions)

      const candidates = sessions.filter((session) => {
        const previous = previousBaseline.get(session.username)
        if (this.shouldInspectSession(previous, session)) {
          return true
        }
        if (scanMessageBackedSessions && this.shouldScanMessageBackedSession(previous, session)) {
          return true
        }
        return forceSystemScan && this.shouldInspectSessionForSystemScan(session)
      })
      for (const session of candidates) {
        await this.pushSessionMessages(
          session,
          previousBaseline.get(session.username) || this.sessionBaseline.get(session.username),
          { systemScan: forceSystemScan }
        )
      }
    } finally {
      this.processing = false
      if (this.rerunRequested) {
        this.rerunRequested = false
        this.scheduleSync({
          scanMessageBackedSessions: this.messageTableScanRequested,
          scanSystemEvents: this.systemScanRequested
        })
      }
    }
  }

  private setBaseline(sessions: ChatSession[]): void {
    const previousBaseline = new Map(this.sessionBaseline)
    const nextBaseline = new Map<string, SessionBaseline>()
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.sessionBaseline.clear()
    for (const session of sessions) {
      const username = String(session.username || '').trim()
      if (!username) continue
      const previous = previousBaseline.get(username)
      const sessionTimestamp = Number(session.lastTimestamp || 0)
      const initialTimestamp = sessionTimestamp > 0 ? sessionTimestamp : nowSeconds
      nextBaseline.set(username, {
        lastTimestamp: Math.max(sessionTimestamp, Number(previous?.lastTimestamp || 0), previous ? 0 : initialTimestamp),
        unreadCount: Number(session.unreadCount || 0),
        summary: String(session.summary || '').trim(),
        lastMsgType: Number(session.lastMsgType || 0)
      })
    }
    for (const [username, baseline] of nextBaseline.entries()) {
      this.sessionBaseline.set(username, baseline)
    }
  }

  private shouldInspectSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const summary = String(session.summary || '').trim()
    const lastMsgType = Number(session.lastMsgType || 0)
    const lastTimestamp = Number(session.lastTimestamp || 0)
    const unreadCount = Number(session.unreadCount || 0)
    const immediateSystemEvent = this.isImmediateSystemEventSession(sessionId, summary, lastMsgType)

    if (!previous) {
      return unreadCount > 0 && lastTimestamp > 0
    }

    if (immediateSystemEvent && this.isSessionSummaryChanged(previous, session)) {
      return true
    }

    return lastTimestamp > previous.lastTimestamp || unreadCount > previous.unreadCount
  }

  private shouldScanMessageBackedSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const summary = String(session.summary || '').trim()
    if (Number(session.lastMsgType || 0) === 10002 || summary.includes('撤回了一条消息')) {
      return false
    }

    const sessionType = this.getSessionType(sessionId, session)
    if (sessionType === 'private') {
      return false
    }

    return Boolean(previous) || Number(session.lastTimestamp || 0) > 0
  }

  private isSessionSummaryChanged(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    if (!previous) return false
    const previousSummary = String(previous.summary || '').trim()
    const currentSummary = String(session.summary || '').trim()
    const previousLastMsgType = Number(previous.lastMsgType || 0)
    const currentLastMsgType = Number(session.lastMsgType || 0)

    return previousSummary !== currentSummary || previousLastMsgType !== currentLastMsgType
  }

  private isImmediateSystemEventSession(sessionId: string, summary: string, lastMsgType: number): boolean {
    const normalizedSessionId = String(sessionId || '').trim().toLowerCase()
    const normalizedSummary = String(summary || '').trim().toLowerCase()

    if (lastMsgType === 10002 || normalizedSummary.includes('撤回了一条消息') || normalizedSummary.includes('撤回了消息')) {
      return true
    }

    if (!normalizedSessionId.endsWith('@chatroom')) {
      return false
    }

    return normalizedSummary.includes('加入了群聊') || normalizedSummary.includes('加入群聊')
  }

  private shouldInspectSessionForSystemScan(session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }
    return true
  }

  private async pushSessionMessages(
    session: ChatSession,
    previous: SessionBaseline | undefined,
    options: { systemScan?: boolean } = {}
  ): Promise<void> {
    const systemScan = options.systemScan === true
    const since = systemScan
      ? Math.max(0, Math.floor(Date.now() / 1000) - this.systemEventLookbackSec)
      : Math.max(0, Number(previous?.lastTimestamp || 0))
    const newMessagesResult = await chatService.getNewMessages(session.username, since, 1000)
    if (!newMessagesResult.success || !newMessagesResult.messages || newMessagesResult.messages.length === 0) {
      return
    }

    for (const message of newMessagesResult.messages) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue
      if (this.isRecentMessage(messageKey)) {
        continue
      }

      const payload = await this.buildPayload(session, message)
      if (!payload) continue
      if (payload.event === 'message.new' && message.isSend === 1) continue
      if (!systemScan && previous && Number(message.createTime || 0) <= Number(previous.lastTimestamp || 0)) {
        continue
      }
      if (systemScan && payload.event === 'message.new') continue
      if (!this.shouldPushPayload(payload)) continue

      httpService.broadcastMessagePush(payload)
      this.rememberMessageKey(messageKey)
      this.bumpSessionBaseline(session.username, message)
    }
  }

  private async buildPayload(session: ChatSession, message: Message): Promise<MessagePushPayload | null> {
    const sessionId = String(session.username || '').trim()
    const messageKey = String(message.messageKey || '').trim()
    if (!sessionId || !messageKey) return null

    const event = this.resolveEventType(session, message)
    const isGroup = sessionId.endsWith('@chatroom')
    const sessionType = this.getSessionType(sessionId, session)
    const content = this.getMessageDisplayContent(message)

    if (isGroup) {
      const groupInfo = await chatService.getContactAvatar(sessionId)
      const groupName = session.displayName || groupInfo?.displayName || sessionId
      const sourceName = await this.resolveGroupSourceName(sessionId, message, session, event)
      return {
        event,
        sessionId,
        sessionType,
        messageKey,
        localType: Number(message.localType || 0),
        createTime: Number(message.createTime || 0),
        avatarUrl: session.avatarUrl || groupInfo?.avatarUrl,
        groupName,
        sourceName,
        content
      }
    }

    const contactInfo = await chatService.getContactAvatar(sessionId)
    return {
      event,
      sessionId,
      sessionType,
      messageKey,
      localType: Number(message.localType || 0),
      createTime: Number(message.createTime || 0),
      avatarUrl: session.avatarUrl || contactInfo?.avatarUrl,
      sourceName: session.displayName || contactInfo?.displayName || sessionId,
      content
    }
  }

  private resolveEventType(session: ChatSession, message: Message): MessagePushEventName {
    const localType = Number(message.localType || 0)
    const rawContent = String(message.rawContent || '')
    const parsedContent = String(message.parsedContent || '')
    const normalized = `${rawContent}\n${parsedContent}`.toLowerCase()

    if (
      localType === 10002
      || normalized.includes('revokemsg')
      || normalized.includes('撤回了一条消息')
      || normalized.includes('撤回了消息')
    ) {
      return 'message.revoke'
    }

    if (
      String(session.username || '').trim().endsWith('@chatroom')
      && this.isGroupInviteMessage(message)
    ) {
      return 'group.invite'
    }

    return 'message.new'
  }

  private isGroupInviteMessage(message: Message): boolean {
    const rawContent = String(message.rawContent || '')
    const parsedContent = String(message.parsedContent || '')
    const normalizedRaw = rawContent
      .replace(/<!\[CDATA\[/gi, '')
      .replace(/\]\]>/g, '')
    const normalizedParsed = parsedContent
      .replace(/<!\[CDATA\[/gi, '')
      .replace(/\]\]>/g, '')

    return /:\s*invite\b/i.test(normalizedRaw) || /:\s*invite\b/i.test(normalizedParsed)
  }

  private getSessionType(sessionId: string, session: ChatSession): MessagePushPayload['sessionType'] {
    if (sessionId.endsWith('@chatroom')) {
      return 'group'
    }
    if (sessionId.startsWith('gh_') || session.type === 'official') {
      return 'official'
    }
    if (session.type === 'friend') {
      return 'private'
    }
    return 'other'
  }

  private shouldPushPayload(payload: MessagePushPayload): boolean {
    const sessionId = String(payload.sessionId || '').trim()
    const filterMode = this.getMessagePushFilterMode()
    if (filterMode === 'all') {
      return true
    }

    const filterList = this.getMessagePushFilterList()
    const listed = filterList.has(sessionId)
    if (filterMode === 'whitelist') {
      return listed
    }
    return !listed
  }

  private getMessagePushFilterMode(): 'all' | 'whitelist' | 'blacklist' {
    const value = this.configService.get('messagePushFilterMode')
    if (value === 'whitelist' || value === 'blacklist') return value
    return 'all'
  }

  private getMessagePushFilterList(): Set<string> {
    const value = this.configService.get('messagePushFilterList')
    if (!Array.isArray(value)) return new Set()
    return new Set(value.map((item) => String(item || '').trim()).filter(Boolean))
  }

  private isSessionTableChange(tableName: string): boolean {
    return String(tableName || '').trim().toLowerCase() === 'session'
  }

  private isMessageTableChange(tableName: string): boolean {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized) return false
    return normalized === 'message' ||
      normalized === 'msg' ||
      normalized.startsWith('message_') ||
      normalized.startsWith('msg_') ||
      normalized.includes('message')
  }

  private bumpSessionBaseline(sessionId: string, message: Message): void {
    const key = String(sessionId || '').trim()
    if (!key) return

    const createTime = Number(message.createTime || 0)
    if (!Number.isFinite(createTime) || createTime <= 0) return

    const current = this.sessionBaseline.get(key) || {
      lastTimestamp: 0,
      unreadCount: 0,
      summary: '',
      lastMsgType: 0
    }
    if (createTime > current.lastTimestamp) {
      this.sessionBaseline.set(key, {
        ...current,
        lastTimestamp: createTime
      })
    }
  }

  private getMessageDisplayContent(message: Message): string | null {
    const cleanOfficialPrefix = (value: string | null): string | null => {
      if (!value) return value
      return value.replace(/^\s*\[视频号\]\s*/u, '').trim() || value
    }
    switch (Number(message.localType || 0)) {
      case 1:
        return cleanOfficialPrefix(message.rawContent || null)
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 42:
        return cleanOfficialPrefix(message.cardNickname || '[名片]')
      case 48:
        return '[位置]'
      case 49:
        return cleanOfficialPrefix(message.linkTitle || message.fileName || '[消息]')
      case 10002:
        return cleanOfficialPrefix(message.parsedContent || message.rawContent || '[撤回消息]')
      case 10000:
        return cleanOfficialPrefix(message.parsedContent || message.rawContent || '[系统消息]')
      default:
        return cleanOfficialPrefix(message.parsedContent || message.rawContent || null)
    }
  }

  private async resolveGroupSourceName(
    chatroomId: string,
    message: Message,
    session: ChatSession,
    event?: MessagePushEventName
  ): Promise<string> {
    const senderUsername = String(message.senderUsername || '').trim()
    if (event === 'group.invite' || event === 'message.revoke') {
      if (!senderUsername || senderUsername === chatroomId) {
        return '系统消息'
      }
    }

    if (!senderUsername) {
      return session.lastSenderDisplayName || '未知发送者'
    }

    const groupNicknames = await this.getGroupNicknames(chatroomId)
    const senderKey = senderUsername.toLowerCase()
    const nickname = groupNicknames[senderKey]

    if (nickname) {
      return nickname
    }

    const contactInfo = await chatService.getContactAvatar(senderUsername)
    return contactInfo?.displayName || senderUsername
  }

  private async getGroupNicknames(chatroomId: string): Promise<Record<string, string>> {
    const cacheKey = String(chatroomId || '').trim()
    if (!cacheKey) return {}

    const cached = this.groupNicknameCache.get(cacheKey)
    if (cached && Date.now() - cached.updatedAt < this.groupNicknameCacheTtlMs) {
      return cached.nicknames
    }

    const result = await wcdbService.getGroupNicknames(cacheKey)
    const nicknames = result.success && result.nicknames
      ? this.sanitizeGroupNicknames(result.nicknames)
      : {}
    this.groupNicknameCache.set(cacheKey, { nicknames, updatedAt: Date.now() })
    return nicknames
  }

  private sanitizeGroupNicknames(nicknames: Record<string, string>): Record<string, string> {
    const buckets = new Map<string, Set<string>>()
    for (const [memberIdRaw, nicknameRaw] of Object.entries(nicknames || {})) {
      const memberId = String(memberIdRaw || '').trim().toLowerCase()
      const nickname = String(nicknameRaw || '').trim()
      if (!memberId || !nickname) continue
      const slot = buckets.get(memberId)
      if (slot) {
        slot.add(nickname)
      } else {
        buckets.set(memberId, new Set([nickname]))
      }
    }

    const trusted: Record<string, string> = {}
    for (const [memberId, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted[memberId] = Array.from(nicknameSet)[0]
    }
    return trusted
  }

  private isRecentMessage(messageKey: string): boolean {
    this.pruneRecentMessageKeys()
    const timestamp = this.recentMessageKeys.get(messageKey)
    return typeof timestamp === 'number' && Date.now() - timestamp < this.recentMessageTtlMs
  }

  private rememberMessageKey(messageKey: string): void {
    this.recentMessageKeys.set(messageKey, Date.now())
    this.pruneRecentMessageKeys()
  }

  private pruneRecentMessageKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.recentMessageKeys.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.recentMessageKeys.delete(key)
      }
    }
  }

}

export const messagePushService = new MessagePushService()
