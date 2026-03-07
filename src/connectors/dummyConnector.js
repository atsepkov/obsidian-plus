import TagConnector from './tagConnector.js';

export default class DummyConnector extends TagConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('DummyConnector initialized');
    }

    // this connector is only meant for testing, it will pass/fail based on presence of the word 'error' in the task
    async onTrigger(task) {
        console.log('DummyConnector triggered', task);
        if (task.text.includes('error')) {
            throw new Error('Task contains the word "error"');
        }
        return { ok: true };
    }
}