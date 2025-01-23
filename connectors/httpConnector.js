import TagConnector from './tagConnector.js';

/* Supported config fields:
    - url: string
    - port: number
    - method: string
    - headers: object
    - fields: string[]
    - auth: object
        - type: string
        - apiKey: string
        - username: string
        - password: string
        - token: string
*/

export default class HttpConnector extends TagConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('HttpConnector initialized');
    }

    // fires when user clicks the checkbox next to the tag
	async onTrigger(task) {
        console.log(`${this.tag} connector triggered`, task);
        // Get the tag from the task
        const tag = task.tag;

        // Get the webhook URL from the configuration
        let endpoint = this.config.url;
        if (this.config.port) {
            endpoint = `${endpoint}:${this.config.port}`;
        }

        // If config has a fields property, filter the task fields
        let data = {};
        if (this.config.fields) {
            const fields = this.config.fields;
            for (const field in fields) {
                data[field] = task[fields[field]];
            }
        } else {
            data = task;
        }

        // Prepare authentication options
        const authOptions = this.prepareAuthOptions();

        // Send the http request
        const response = this.sendRequest(endpoint, data, authOptions);
        if (response.ok) {
            console.log('HTTP request sent successfully');
        }
        return response;
    }

    // fires after the transaction success is confirmed
	async onSuccess(task, response) {
        console.log(`${this.tag} connector transaction successful`, task, response);
        // update task visual to show success
        let status = '✓';
        if (this.config.timestamps) {
            status += ` ${new Date().toLocaleString()}`;
        }

        // Take the response json and  convert each key value pair to a separate entry
        let children = [];
        const result = await response.json();
        for (const key in result) {
            children.push(`${key}: ${result[key]}`);
        }

        await this.obsidianPlus.updateTask(task, {
            append: status,
            appendChildren: children,
            useBullet: '+'
        });
    }

    // fires after the transaction fails
    async onError(task, error) {
        console.log(`${this.tag} connector transaction failed`, task, error);
        await this.obsidianPlus.changeTaskStatus(task, 'error', error);
        if (this.config.retry) {
            for (let i = 0; i < parseInt(this.config.retry); i++) {
                // retry the transaction
                await this.onTrigger(task);
            }
        }
        let message = '';
        console.log('property names', Object.getOwnPropertyNames(error), error.message);
        if (error.message.includes('402')) {
            message = 'Payment Required';
        } else {
            message += error;
        }
        if (this.config.timestamps) {
            message += ` (${new Date().toLocaleString()})`;
        }
        await this.obsidianPlus.updateTask(task, {
            appendChildren: [message],
            useBullet: '*'
        });
    }

    prepareAuthOptions() {
        const headers = {};

        if (this.config.auth) {
            const { type, apiKey, username, password, token } = this.config.auth;

            switch (type) {
                case 'apiKey':
                    // Add API key to a custom header (e.g., 'X-API-Key')
                    headers['X-API-Key'] = apiKey;
                    break;
                case 'basic':
                    // Add Basic Authentication header
                    if (username && password) {
                        const credentials = btoa(`${username}:${password}`);
                        headers['Authorization'] = `Basic ${credentials}`;
                    } else {
                        console.warn('Basic auth requires both username and password.');
                    }
                    break;
                case 'bearer':
                    // Add Bearer token to Authorization header
                    if (token) {
                        headers['Authorization'] = `Bearer ${token}`;
                    } else {
                        console.warn('Bearer auth requires a token.');
                    }
                    break;
                default:
                    console.warn('Unsupported authentication type:', type);
            }
        }

        return { headers };
    }

    async sendRequest(url, data, options = {}) {
        // Determine the HTTP method
        const method = options.method || this.config.method || 'GET';

        // Prepare fetch options
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
            console.error(`Failed to send: ${error}`);
            // Optionally implement retry logic or further error handling
            throw error;
        }
    }
}