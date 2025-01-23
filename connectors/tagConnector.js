export default class TagConnector {
	constructor(tag, obsidianPlus, config = {}) {
        this.tag = tag;
        this.obsidianPlus = obsidianPlus;
        this.config = config;
        if (!this.config.errorFormat) {
            this.config.errorFormat = '✗ '
        }
    }

    // fires when user clicks the checkbox next to the tag
	async onTrigger(task) {
        console.log(`${this.tag} connector triggered`, task);
        throw new Error('onTrigger not implemented');
    }

    // fires after the transaction success is confirmed
	async onSuccess(task, response) {
        console.log(`${this.tag} connector transaction successful`, task, response);
        // update task visual to show success
        let message = '✓';
        if (this.config.timestamps) {
            message += ` ${new Date().toLocaleString()}`;
        }
        await this.obsidianPlus.updateTask(task, { append: message });
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
        let message = `✗ ${error}`;
        if (this.config.timestamps) {
            message += ` (${new Date().toLocaleString()})`;
        }
        await this.obsidianPlus.updateTask(task, {
            prependChildren: [message]
        });
    }

    // fires when user clears the checkbox next to the tag
    async onReset(task) {
        console.log(`${this.tag} connector reset`, task);
        // we need to remove the checkmark from the task (timestamp too)
        const statusRegex = new RegExp(`✓.*$`, 'm');
        await this.obsidianPlus.updateTask(task, { replace: (line) => line.replace(statusRegex, '') });
    }

    // fires when we receive a data feed from a resource
    async onData(data) {

    }

    // function that runs to decide whether the task will be rendered in the getSummary view
    defaultFilter(task) {
        return true;
    }

    // functions that formats the task for the getSummary view
    defaultFormat(task) {
        return task;
    }
}