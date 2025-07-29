import { SLOT_MS, nextSlot, alignedNextDue, applyTemplate } from "./utilities";

export class PollingManager {
  private plugin: any;
  private slotId: NodeJS.Timer | null;       // repeating 1-minute heartbeat
  private bootstrapId: NodeJS.Timeout | null; // one-shot align-to-clock timer

  constructor(plugin: any) {
    this.plugin      = plugin;
    this.slotId      = null;
    this.bootstrapId = null;
  }

  /* ───────────────────────────── public API ────────────────────────── */
  start()  { this._beginSlotTicker(); }

  reload() {
    // clear BOTH the interval and any still-pending bootstrap timeout
    if (this.slotId      !== null) { clearInterval(this.slotId);      this.slotId      = null; }
    if (this.bootstrapId !== null) { clearTimeout (this.bootstrapId); this.bootstrapId = null; }
    this._beginSlotTicker();
  }

  /* ─────────────────────── slot-based scheduler ────────────────────── */
  private _beginSlotTicker() {
    const delay = nextSlot() - Date.now();      // align to next full minute

    this.bootstrapId = setTimeout(() => {
      this._tick();                             // first run at the slot boundary

      this.slotId = setInterval(() => this._tick(), SLOT_MS);
      this.plugin.registerInterval(this.slotId);

      this.bootstrapId = null;                  // bootstrap done
    }, delay);
  }

/* ─── once-per-minute scheduler ───────────────────────────────────── */
private async _tick() {
    const subs = this.plugin.settings.subscribe;
    const now  = Date.now();
  
    for (const [tag, entry] of Object.entries(subs)) {
      if (!entry.active) continue;                    // unchecked
      if (now < entry.nextDue) continue;              // not in this slot
  
      /* Dedup guard: if this tag ran less than `interval` ago, skip.
         Protects against multiple devices or stray extra tickers. */
      if (entry.lastRun && now - entry.lastRun < entry.interval) continue;
  
      try {
        await this._poll(tag, entry as any);
        entry.lastRun = now;                          // record success
        console.log(`[Subscribe] ${tag} OK`);
      } catch (e) {
        console.error(`[Subscribe] ${tag} failed`, e);
        entry.nextDue += entry.interval;             // simple back-off
      }
  
      entry.nextDue = alignedNextDue(entry.interval, now + 1);
    }
  
    await this.plugin.saveSettings();                // sync across devices
  }
  
  /* ─── one network call ─────────────────────────────────────────────── */
  private async _poll(tag: string, entry: any) {
    if (entry._busy) return;          // another device / ticker already in flight
    entry._busy = true;
  
    try {
      const { connector, config } = entry;
  
      const resp = await connector.sendRequest(
        connector.config.url,
        {},
        connector.prepareAuthOptions?.());
  
      const data = await resp.json;
      await this._writeToLog(tag, data, config.format);
  
    } finally {
      entry._busy = false;
    }
  }

  /* append line to Transactions/tx-YYYY-MM-DD.md */
  private async _writeToLog(tag: string, payload: any, format: string = "{value}") {
    const vault  = this.plugin.app.vault;
    const folder = "Transactions";
    const dayStr = window.moment().format("YYYY-MM-DD");
    const file   = `${folder}/tx-${dayStr}.md`;

    if (!vault.getAbstractFileByPath(folder))
      await vault.createFolder(folder).catch(()=>{});
    if (!vault.getAbstractFileByPath(file))
      await vault.create(file, "");

    const rendered = applyTemplate(format, { ...payload, value: JSON.stringify(payload) });
    const line     = `+ ${tag} ${rendered} (${window.moment().format("HH:mm")})\n`;

    const tfile = vault.getAbstractFileByPath(file);
    await vault.append(tfile, line);
  }
}
