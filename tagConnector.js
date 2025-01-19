export class TagConnector {
	constructor(tag, obsidianPlus, config) {
        this.tag = tag;
        this.obsidianPlus = obsidianPlus;
        this.config = config;
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
                data[key.trim()] = task[value.trim()];
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

    // fires when user clears the checkbox next to the tag
    async onReset(task) {
        console.log('TagConnector reset', task);
        await this.obsidianPlus.updateTask(task, { trimEnd: '✓' });
    }

    // fires after the transaction success is confirmed
	async onSuccess(task, response) {
        console.log('TagConnector transaction successful', task, response);
        // update task visual to show success
       await this.obsidianPlus.updateTask(task, { append: '✓' });
    }

    // fires after the transaction fails
    async onError(task, error) {
        console.error('TagConnector transaction failed', task, error);
        await this.obsidianPlus.changeTaskStatus(task, 'error', error);
    }

    // function that runs to decide whether the task will be rendered in the getSummary view
    defaultFilter(task) {
    
    }

    // functions that formats the task for the getSummary view
    defaultFormat(task) {
    
    }

    async sendWebhook(url, data, options = {}) {
        // Default options
        const fetchOptions = {
            method: options.method || 'POST', 
            headers: {
            'Content-Type': 'application/json',
            ...options.headers
            },
            body: JSON.stringify(data),
            // Add other options like timeout, etc., if needed.
        };

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