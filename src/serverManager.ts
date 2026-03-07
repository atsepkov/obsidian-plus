/**
 * ServerManager - Handles communication with obsidian-plus-server
 *
 * Responsibilities:
 * - Registration (get client ID, secret, JWT token)
 * - Channel subscriptions
 * - Polling for messages (with `since` tracking)
 * - Writing received messages to tx-log (portal writing in future)
 */

import { Notice, requestUrl } from 'obsidian';

export interface ServerCredentials {
  url: string;
  clientId: string;
  token: string;
  secret: string;
  lastPolled: number;
  processedMessageIds: string[];
}

export interface ServerMessage {
  id: string;
  channel: string;
  sender_id: string;
  content: string;
  timestamp: number;
  parent_id: string | null;
}

const MAX_PROCESSED_IDS = 1000; // Keep last N message IDs for dedup

export class ServerManager {
  private plugin: any;
  private pollTimer: NodeJS.Timer | null = null;
  private pollInterval: number = 5 * 60 * 1000; // 5 minutes default

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  // ─────────────────────────── Credentials ───────────────────────────

  private get credentials(): ServerCredentials | null {
    return this.plugin.settings.serverCredentials ?? null;
  }

  private async saveCredentials(creds: Partial<ServerCredentials>): Promise<void> {
    this.plugin.settings.serverCredentials = {
      ...this.plugin.settings.serverCredentials,
      ...creds,
    };
    await this.plugin.saveSettings();
  }

  isRegistered(): boolean {
    const creds = this.credentials;
    return !!(creds?.clientId && creds?.token);
  }

  // ─────────────────────────── Registration ───────────────────────────

  async register(serverUrl: string): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${serverUrl}/register`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status !== 201) {
        console.error('[ServerManager] Registration failed:', response.text);
        new Notice('Server registration failed');
        return false;
      }

      const { id, secret, token } = response.json;

      await this.saveCredentials({
        url: serverUrl,
        clientId: id,
        token,
        secret,
        lastPolled: 0,
        processedMessageIds: [],
      });

      console.log('[ServerManager] Registered successfully:', id);
      new Notice('Server registration successful');
      return true;
    } catch (error) {
      console.error('[ServerManager] Registration error:', error);
      new Notice('Server registration error: ' + error.message);
      return false;
    }
  }

  async unregister(): Promise<void> {
    this.stopPolling();
    this.plugin.settings.serverCredentials = null;
    await this.plugin.saveSettings();
    console.log('[ServerManager] Unregistered');
    new Notice('Server credentials cleared');
  }

  // ─────────────────────────── Subscriptions ───────────────────────────

  async subscribe(channel: string): Promise<boolean> {
    const creds = this.credentials;
    if (!creds) {
      console.error('[ServerManager] Not registered');
      return false;
    }

    try {
      const response = await requestUrl({
        url: `${creds.url}/subscribe`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.token}`,
        },
        body: JSON.stringify({ channel }),
      });

      if (response.status !== 200) {
        console.error('[ServerManager] Subscribe failed:', response.text);
        return false;
      }

      console.log('[ServerManager] Subscribed to:', channel);
      return true;
    } catch (error) {
      console.error('[ServerManager] Subscribe error:', error);
      return false;
    }
  }

  // ─────────────────────────── Polling ───────────────────────────

  startPolling(intervalMs?: number): void {
    if (this.pollTimer) {
      this.stopPolling();
    }

    const interval = intervalMs ?? this.pollInterval;

    // Initial poll
    this.poll();

    // Schedule recurring polls
    this.pollTimer = setInterval(() => this.poll(), interval);
    this.plugin.registerInterval(this.pollTimer);

    console.log('[ServerManager] Polling started, interval:', interval / 1000, 'seconds');
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[ServerManager] Polling stopped');
    }
  }

  async poll(): Promise<ServerMessage[]> {
    const creds = this.credentials;
    if (!creds) {
      console.warn('[ServerManager] Not registered, skipping poll');
      return [];
    }

    try {
      const since = creds.lastPolled || 0;
      const response = await requestUrl({
        url: `${creds.url}/poll?since=${since}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
        },
      });

      if (response.status !== 200) {
        console.error('[ServerManager] Poll failed:', response.text);
        await this.writeToTxLog('*', `Poll error: ${response.status}`);
        return [];
      }

      const messages: ServerMessage[] = response.json;
      console.log('[ServerManager] Polled', messages.length, 'messages since', since);

      // Process new messages
      const newMessages: ServerMessage[] = [];
      for (const msg of messages) {
        if (this.isMessageProcessed(msg.id)) {
          continue; // Skip already processed
        }

        // Write to tx-log for now (portal writing in future)
        await this.writeToTxLog(msg.channel, msg.content, msg.sender_id);

        this.markMessageProcessed(msg.id);
        newMessages.push(msg);
      }

      // Update lastPolled timestamp
      if (messages.length > 0) {
        const maxTimestamp = Math.max(...messages.map(m => m.timestamp));
        await this.saveCredentials({ lastPolled: maxTimestamp });
      }

      return newMessages;
    } catch (error) {
      console.error('[ServerManager] Poll error:', error);
      await this.writeToTxLog('*', `Poll error: ${error.message}`);
      return [];
    }
  }

  // ─────────────────────────── Deduplication ───────────────────────────

  private isMessageProcessed(messageId: string): boolean {
    const creds = this.credentials;
    return creds?.processedMessageIds?.includes(messageId) ?? false;
  }

  private async markMessageProcessed(messageId: string): Promise<void> {
    const creds = this.credentials;
    if (!creds) return;

    const ids = creds.processedMessageIds || [];
    ids.push(messageId);

    // Trim to keep only last N IDs
    if (ids.length > MAX_PROCESSED_IDS) {
      ids.splice(0, ids.length - MAX_PROCESSED_IDS);
    }

    await this.saveCredentials({ processedMessageIds: ids });
  }

  // ─────────────────────────── Tx-Log Writing ───────────────────────────

  /**
   * Write to transaction log: Transactions/tx-YYYY-MM-DD.md
   * Format: + channel content (HH:mm)
   * Errors use * bullet instead of +
   */
  private async writeToTxLog(
    channel: string,
    content: string,
    senderId?: string
  ): Promise<void> {
    const vault = this.plugin.app.vault;
    const folder = 'Transactions';
    const dayStr = window.moment().format('YYYY-MM-DD');
    const file = `${folder}/tx-${dayStr}.md`;

    // Ensure folder exists
    if (!vault.getAbstractFileByPath(folder)) {
      await vault.createFolder(folder).catch(() => {});
    }

    // Ensure file exists
    if (!vault.getAbstractFileByPath(file)) {
      await vault.create(file, `# Transactions ${dayStr}\n\n`);
    }

    // Format line based on whether it's an error or normal message
    const bullet = channel === '*' ? '*' : '+';
    const timestamp = window.moment().format('HH:mm');

    let line: string;
    if (channel === '*') {
      // Error format: * error message (HH:mm)
      line = `* ${content} (${timestamp})\n`;
    } else {
      // Normal format: + channel content (sender) (HH:mm)
      const senderSuffix = senderId ? ` [${senderId.slice(0, 8)}]` : '';
      line = `+ ${channel} ${content}${senderSuffix} (${timestamp})\n`;
    }

    const tfile = vault.getAbstractFileByPath(file);
    await vault.append(tfile, line);
    console.log('[ServerManager] Wrote to tx-log:', line.trim());
  }

  // ─────────────────────────── Lifecycle ───────────────────────────

  async reload(): Promise<void> {
    this.stopPolling();

    // Check if we have server config and credentials
    const serverUrl = this.plugin.settings.serverUrl;
    if (!serverUrl) {
      console.log('[ServerManager] No server URL configured');
      return;
    }

    // Auto-register if not registered
    if (!this.isRegistered()) {
      console.log('[ServerManager] Not registered, attempting registration...');
      const success = await this.register(serverUrl);
      if (!success) return;
    }

    // Subscribe to configured channels
    const subscribeChannels = this.plugin.settings.serverSubscriptions || [];
    for (const channel of subscribeChannels) {
      await this.subscribe(channel);
    }

    // Start polling
    this.startPolling();
  }
}
