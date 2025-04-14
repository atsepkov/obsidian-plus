import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import TagConnector from './tagConnector.js';

export default class WebConnector extends TagConnector {
    constructor(tag, obsidianPlus, config = {}) {
        super(tag, obsidianPlus, config);
        this.browser = null;
        this.page = null;
        this.port = config.port || 9222;
        this.profileDir = config.profileDir || `/tmp/obsidian-${Date.now()}`;
        this.chromePath = this.resolveChromePath();
    }

    resolveChromePath() {
        // Platform-specific default paths
        const paths = {
            darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            win32: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            linux: '/usr/bin/google-chrome'
        };
        return this.config.chromePath || paths[process.platform];
    }

    async launchBrowser() {
        return new Promise((resolve, reject) => {
            const args = [
                `--remote-debugging-port=${this.port}`,
                `--user-data-dir=${this.profileDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                `--headless=${this.config.headless !== false}`
            ];

            this.chromeProcess = spawn(this.chromePath, args);
            
            this.chromeProcess.on('error', err => {
                this.onError(null, new Error(`Failed to launch Chrome: ${err.message}`));
                reject(err);
            });

            setTimeout(async () => {
                try {
                    this.browser = await puppeteer.connect({
                        browserURL: `http://localhost:${this.port}`
                    });
                    this.page = await this.browser.newPage();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, 3000); // Wait for Chrome to start
        });
    }

    async onTrigger(task) {
        console.log(`${this.tag} connector triggered`, task);
        try {
            if (!this.browser) {
                await this.launchBrowser();
            }

            // Process commands from task content
            const children = await this.obsidianPlus.taskManager.getDvTaskChildren(this.obsidianPlus.app, task);
            // Note: getContext previously returned { parents, children, links }.
            // If you need parents or links here, you'll need to import and call
            // getDvTaskParents and getDvTaskLinks from taskManager as well.
            // For now, assuming only children were used based on the loop below.
            for (const line of children) {
                await this.handleCommand(line);
            }

            await this.onSuccess(task, { status: 'completed' });
        } catch (error) {
            await this.onError(task, error);
        }
    }

    async handleCommand(commandStr) {
        if (!commandStr) return;
        
        const [action, ...params] = commandStr.split(' ');
        
        try {
            let result;
            switch (action.toLowerCase()) {
                case 'goto':
                    await this.page.goto(params[0]);
                    result = this.page.url() === params[0] ? '✓' : '✗';
                    break;
                    
                case 'screenshot':
                    const path = await this.handleScreenshot(params[0]);
                    result = `![[${path}]]`;
                    break;
                    
                case 'type':
                    await this.page.type(params[0], params.slice(1).join(' '));
                    result = '✓';
                    break;
                    
                case 'click':
                    await this.page.click(params[0]);
                    result = '✓';
                    break;
                    
                case 'waitfor':
                    await this.page.waitForSelector(params[0]);
                    result = '✓';
                    break;
                    
                default:
                    throw new Error(`Unknown command: ${action}`);
            }

            await this.obsidianPlus.taskManager.updateDvTask(this.obsidianPlus.app, task, {
                removeChildrenByBullet: '+*',
                appendChildren: `${commandStr}: ${result}`,
                useBullet: '+'
            });
        } catch (error) {
            throw new Error(`Failed executing "${commandStr}": ${error.message}`);
        }
    }

    async handleScreenshot(filename = `screenshot-${Date.now()}.png`) {
        const buffer = await this.page.screenshot();
        const vault = this.obsidianPlus.app.vault;
        const noteFile = this.obsidianPlus.app.workspace.getActiveFile();
        
        const attachmentPath = await this.obsidianPlus.app.fileManager.getAvailablePathForAttachment(
            filename, 
            noteFile
        );

        await vault.createBinary(attachmentPath, buffer);
        return attachmentPath;
    }

    async onReset(task) {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
        await super.onReset(task);
    }
}
