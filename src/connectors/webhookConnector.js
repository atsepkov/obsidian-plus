import { normalizeConfigVal } from '../utilities';
import { requestUrl } from 'obsidian';
import TagConnector from './tagConnector.js';

export default class WebhookConnector extends TagConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('WebhookConnector initialized');
    }

    // fires when user clicks the checkbox next to the tag
	async onTrigger(task) {
        console.log('WebhookConnector triggered', task);
        // Get the tag from the task
        const tag = task.tag;

        // Get the webhook URL from the configuration
        const webhookUrl = this.config.webhookUrl;

        // If config has a fields property, filter the task fields
        let data = {};
        if (this.config.fields) {
            const fields = this.config.fields;
            for (const field of fields) {
                const [key, value] = field.split(':');
                data[normalizeConfigVal(key)] = task[normalizeConfigVal(value)];
            }
        } else {
            data = task;
        }

        // Send the webhook
        const response = await this.sendWebhook(webhookUrl, data)
        if (response.ok) {
            console.log('Webhook sent successfully');
        }
        return response;
    }

    async onSuccess(task, response) {
        console.log(`${this.tag} connector transaction successful`, task, response);
        // update task visual to show success
        let message = '✓';
        if (this.config.timestamps) {
            message += ` ${new Date().toLocaleString()}`;
        }

        if (this.config.printResponse) {
            const json = await response.json();
            const lines = [];
            for (const key in json) {
                lines.push(`${key}: ${json[key]}`);
            }
            await this.obsidianPlus.updateTask(task, {
                append: message,
                removeChildrenByBullet: '*+',
                prependChildren: await this.convertLinesToChildren(lines),
                useBullet: '+',
            });
        } else {
            await this.obsidianPlus.updateTask(task, {
                append: message,
                removeChildrenByBullet: '+*',
            });
        }
    }

    async sendWebhook(url, data, options = {}) {
        // Prepare fetch options
        const method = options.method || 'POST';
        const fetchOptions = {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers,
                ...options.headers,
            },
        };

        // Handle GET requests: append data as query parameters
        if (method === 'GET' || method === 'HEAD') {
            const urlParams = new URLSearchParams(data).toString();
            url = `${url}?${urlParams}`;
        } else {
            // For other methods, include the body
            fetchOptions.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, fetchOptions);
            
            // Check for a successful status
            if (!response.ok) {
                // Log or handle errors as needed
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return response;
        } catch (error) {
            console.error(`Failed to send webhook: ${error}`);
            // Optionally implement retry logic or further error handling
            throw error;
        }
    }

    /**
     * Fire-and-forget by default (fetch + no-cors).  
     * If you need to read the reply set `printResponse: true`
     * in the connector’s YAML / JSON config and we’ll switch to requestUrl.
     */
    // async sendWebhook(url, data = {}, options = {}) {
    //     const wantResponse = this.config.printResponse ?? false;
    //     const method       = (options.method || "POST").toUpperCase();
    //     const headers      = {
    //         "Content-Type": "application/json",
    //         ...(this.config.headers ?? {}),
    //         ...options.headers,
    //     };

    //     // ---------- 1) Fire-and-forget path (no pre-flight, no CORS headaches) ----------
    //     if (!wantResponse) {
    //         const fetchOpts = {
    //             method,
    //             mode:  "no-cors",
    //             headers,
    //             body:  method === "GET" || method === "HEAD" ? undefined : JSON.stringify(data),
    //         };
    //         await fetch(url, fetchOpts).catch(console.error);   // we don’t really care
    //         return { ok: true, status: 204, json: async () => ({}) };
    //     }

    //     // ---------- 2) Need the JSON back → use Obsidian’s requestUrl ----------
    //     const res = await requestUrl({
    //         url,
    //         method,
    //         headers,
    //         body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(data),
    //     });
    //     if (res.status < 200 || res.status >= 300)
    //         throw new Error(`HTTP ${res.status}`);
    //     return res;
    // }
}