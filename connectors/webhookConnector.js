import { normalizeConfigVal } from '../utilities/basic.js';
import TagConnector from './tagConnector.js';

export default class WebhookConnector extends TagConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('WebhookConnector initialized');
    }

    // fires when user clicks the checkbox next to the tag
	async onTrigger(task) {
        console.log('TagConnector triggered', task);
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
        const response = this.sendWebhook(webhookUrl, data)
        if (response.ok) {
            console.log('Webhook sent successfully');
        }
        return response;
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
}