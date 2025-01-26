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
        await this.obsidianPlus.updateTask(task, {
            append: message,
            removeChildrenByBullet: this.config.clearErrorsOnSuccess ? '*' : undefined,
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
        let message = `✗ ${error}`;
        if (this.config.timestamps) {
            message += ` (${new Date().toLocaleString()})`;
        }
        await this.obsidianPlus.updateTask(task, {
            prependChildren: TagConnector.convertLinesToChildren([message])
        });
    }

    // fires when user clears the checkbox next to the tag
    async onReset(task) {
        console.log(`${this.tag} connector reset`, task);
        // we need to remove the checkmark from the task (timestamp too)
        const statusRegex = new RegExp(`✓.*$`, 'm');
        await this.obsidianPlus.updateTask(task, {
            replace: (line) => line.replace(statusRegex, ''),
            removeChildrenByBullet: this.config.clearErrorsOnReset ? '*' : undefined,
        });
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

    /**
     * Converts an array of list item strings into structured entries with calculated indentation.
     * @param {string[]} lines - Array of list item strings.
     * @returns {Array<{indent: number, offset: number, text: string}>} - Processed entries.
     */
    static convertLinesToChildren(lines) {
        if (!lines || lines.length === 0) return [];
        
        const entries = [];
        let indentStep = 2; // Default step if detection fails
        
        // Calculate leading whitespace for a line (spaces only)
        const getLeadingSpaces = line => (line.match(/^ */)?.[0]?.length || 0);

        // Determine indentation step from first two lines
        if (lines.length >= 2) {
            const first = getLeadingSpaces(lines[0]);
            const second = getLeadingSpaces(lines[1]);
            indentStep = Math.abs(second - first) || 2;
        }

        const baseIndent = getLeadingSpaces(lines[0]);
        
        lines.forEach((line, index) => {
            const leadingSpaces = getLeadingSpaces(line);
            const text = line.trim();
            
            // Calculate relative indent level
            let indent = Math.round((leadingSpaces - baseIndent) / indentStep);
            indent = Math.max(indent, 0); // No negative indents
            
            entries.push({
                indent,
                offset: index + 1, // Lines are sequential after parent
                text
            });
        });

        return entries;
    }
}