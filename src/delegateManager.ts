/**
 * DelegateManager
 *
 * Enables vault-based delegation of DSL trigger execution to remote devices.
 * When a tag has `delegate: <device-name>`, triggers are serialized to a signal
 * file in `.obsidian-plus/delegate/`. The named device polls for signals and
 * executes them locally, writing results directly to the notebook.
 */

import { Notice, TFile, TFolder } from 'obsidian';
import type ObsidianPlus from './main';
import { createDSLEngine, type TriggerType, type DSLConfig } from './dsl';
import { isDSLConnector } from './connectorFactory';
import type DSLConnector from './connectors/dslConnector';

const DELEGATE_DIR = '.obsidian-plus/delegate';
const POLL_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEVICE_NAME_KEY = 'obsidian-plus-device-name';

/**
 * Get the device name from localStorage (per-device, never syncs).
 */
export function getDeviceName(): string {
    return localStorage.getItem(DEVICE_NAME_KEY) ?? '';
}

/**
 * Set the device name in localStorage (per-device, never syncs).
 */
export function setDeviceName(name: string): void {
    localStorage.setItem(DEVICE_NAME_KEY, name);
}

export interface DelegateSignal {
    to: string;
    tag: string;
    file: string;
    line: number;
    trigger: TriggerType;
    text: string;
    event?: { from?: string; to?: string };
    vars?: Record<string, any>;
    createdAt: number;
}

export class DelegateManager {
    private plugin: ObsidianPlus;
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    constructor(plugin: ObsidianPlus) {
        this.plugin = plugin;
    }

    // ─────────────────────── Sender side ───────────────────────

    async send(opts: {
        tag: string;
        trigger: TriggerType;
        task: any;
        event?: { fromStatus?: string; toStatus?: string };
        file: TFile | null;
        vars?: Record<string, any>;
    }): Promise<{ __delegated: true }> {
        const delegate = this.getDelegateName(opts.tag);
        if (!delegate) {
            throw new Error(`No delegate configured for tag ${opts.tag}`);
        }

        const signal: DelegateSignal = {
            to: delegate,
            tag: opts.tag,
            file: opts.file?.path ?? opts.task.path,
            line: opts.task.line,
            trigger: opts.trigger,
            text: opts.task.text ?? '',
            event: opts.event ? { from: opts.event.fromStatus, to: opts.event.toStatus } : undefined,
            vars: opts.vars,
            createdAt: Date.now(),
        };

        await this.ensureDir();
        const filename = `${Date.now()}-${this.shortId()}.json`;
        const path = `${DELEGATE_DIR}/${filename}`;
        await this.plugin.app.vault.create(path, JSON.stringify(signal, null, 2));

        new Notice(`Delegated ${opts.tag} to ${delegate}`);
        return { __delegated: true };
    }

    // ─────────────────────── Executor side ───────────────────────

    async start(): Promise<void> {
        await this.ensureDir();
        await this.cleanup();

        // Only poll if this device has a name set
        if (!this.myDeviceName()) return;

        this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
        // Run once immediately
        await this.poll();
    }

    stop(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async poll(): Promise<void> {
        const myName = this.myDeviceName();
        if (!myName) return;

        const dir = this.plugin.app.vault.getAbstractFileByPath(DELEGATE_DIR);
        if (!(dir instanceof TFolder)) return;

        for (const child of dir.children) {
            if (!(child instanceof TFile) || !child.name.endsWith('.json')) continue;

            try {
                const content = await this.plugin.app.vault.read(child);
                const signal: DelegateSignal = JSON.parse(content);

                if (signal.to !== myName) continue;

                await this.executeSignal(signal);
                // Delete signal file after successful execution
                await this.plugin.app.vault.delete(child);
            } catch (e) {
                console.error(`[DelegateManager] Error processing signal ${child.name}:`, e);
                // On execution error, try to mark the task as failed
                try {
                    const content = await this.plugin.app.vault.read(child);
                    const signal: DelegateSignal = JSON.parse(content);
                    await this.handleSignalError(signal, e as Error);
                    await this.plugin.app.vault.delete(child);
                } catch (innerErr) {
                    console.error(`[DelegateManager] Failed to handle error for ${child.name}:`, innerErr);
                }
            }
        }
    }

    private async executeSignal(signal: DelegateSignal): Promise<void> {
        console.log(`[DelegateManager] Executing signal: ${signal.tag} ${signal.trigger} from ${signal.file}:${signal.line}`);

        const file = this.plugin.app.vault.getAbstractFileByPath(signal.file);
        if (!(file instanceof TFile)) {
            throw new Error(`File not found: ${signal.file}`);
        }

        // Look up the tag's connector to get its DSL config
        // webTags is typed as Record<string, string> but actually stores connector instances at runtime
        const tagConnector = this.plugin.settings.webTags[signal.tag] as any;
        if (!tagConnector || !isDSLConnector(tagConnector)) {
            throw new Error(`No DSL connector found for tag ${signal.tag}`);
        }

        const dslConfig: DSLConfig = tagConnector.getDSLConfig();

        // Find the task via Dataview
        const dv = this.plugin.dv;
        let dvTask: any = null;
        if (dv) {
            const page = dv.page(signal.file);
            if (page?.file?.tasks) {
                dvTask = page.file.tasks.find((t: any) => t.line === signal.line);
            }
        }

        if (!dvTask) {
            throw new Error(`Could not find task at ${signal.file}:${signal.line}`);
        }

        // Create DSL engine and execute
        const engine = createDSLEngine(
            this.plugin.app,
            this.plugin.taskManager,
            this.plugin.tagQuery,
            this.plugin.dv
        );

        const editor = this.plugin.app.workspace.activeEditor?.editor;

        const result = await engine.execute(
            dslConfig,
            signal.trigger,
            {
                task: dvTask,
                line: signal.text,
                file,
                editor,
                initialVars: signal.vars,
            }
        );

        if (result.success) {
            // Set task to [x] on success
            await this.plugin.changeTaskStatus(dvTask, 'x');
            new Notice(`Delegate: ${signal.tag} completed`);
        } else {
            throw result.error ?? new Error('DSL execution failed');
        }
    }

    private async handleSignalError(signal: DelegateSignal, error: Error): Promise<void> {
        console.error(`[DelegateManager] Signal execution failed for ${signal.tag}:`, error);

        try {
            const file = this.plugin.app.vault.getAbstractFileByPath(signal.file);
            if (!(file instanceof TFile)) return;

            // Try to find and mark the task as errored
            const dv = this.plugin.dv;
            if (dv) {
                const page = dv.page(signal.file);
                const dvTask = page?.file?.tasks?.find((t: any) => t.line === signal.line);
                if (dvTask) {
                    await this.plugin.changeTaskStatus(dvTask, '!');
                }
            }

            // Append error as child bullet
            const content = await this.plugin.app.vault.read(file);
            const lines = content.split('\n');
            if (signal.line >= 0 && signal.line < lines.length) {
                const taskLine = lines[signal.line];
                const indent = taskLine.match(/^(\s*)/)?.[1] ?? '';
                const errorBullet = `${indent}\t* ${error.message}`;
                lines.splice(signal.line + 1, 0, errorBullet);
                await this.plugin.app.vault.modify(file, lines.join('\n'));
            }
        } catch (e) {
            console.error('[DelegateManager] Failed to write error to notebook:', e);
        }

        new Notice(`Delegate: ${signal.tag} failed - ${error.message}`);
    }

    // ─────────────────────── Cleanup ───────────────────────

    private async cleanup(): Promise<void> {
        const dir = this.plugin.app.vault.getAbstractFileByPath(DELEGATE_DIR);
        if (!(dir instanceof TFolder)) return;

        const now = Date.now();
        for (const child of dir.children) {
            if (!(child instanceof TFile) || !child.name.endsWith('.json')) continue;

            try {
                const content = await this.plugin.app.vault.read(child);
                const signal: DelegateSignal = JSON.parse(content);
                if (now - signal.createdAt > STALE_THRESHOLD_MS) {
                    console.log(`[DelegateManager] Cleaning up stale signal: ${child.name}`);
                    await this.plugin.app.vault.delete(child);
                }
            } catch {
                // If we can't parse it, delete it
                await this.plugin.app.vault.delete(child);
            }
        }
    }

    // ─────────────────────── Helpers ───────────────────────

    private myDeviceName(): string {
        return getDeviceName();
    }

    /**
     * Get the delegate device name for a tag, or empty string if none.
     */
    getDelegateName(tag: string): string {
        const connector = this.plugin.settings.webTags[tag];
        if (!connector) return '';
        return (connector as any).config?.delegate ?? '';
    }

    /**
     * Returns true if this tag should be delegated to another device.
     */
    shouldDelegate(tag: string): boolean {
        const delegate = this.getDelegateName(tag);
        if (!delegate) return false;
        const myName = this.myDeviceName();
        if (!myName) return false;
        return delegate !== myName;
    }

    private async ensureDir(): Promise<void> {
        const vault = this.plugin.app.vault;

        // Both of these are dotfolders, and `getAbstractFileByPath` does not index hidden
        // paths: it reports missing for a folder that is plainly on disk. The old guard
        // therefore always failed, `createFolder` threw "Folder already exists", and since
        // this is the first await in start(), the poll loop below it never ran at all.
        // Ask the adapter instead, which goes to the filesystem.
        for (const path of ['.obsidian-plus', DELEGATE_DIR]) {
            try {
                if (await vault.adapter.exists(path)) continue;
                await vault.createFolder(path);
            } catch (err) {
                // Tolerate a folder that appeared between the check and the create, on
                // this device or another one syncing underneath us.
                const message = String((err as any)?.message ?? err);
                if (!/already exists/i.test(message)) throw err;
            }
        }
    }

    private shortId(): string {
        return Math.random().toString(36).substring(2, 8);
    }
}
