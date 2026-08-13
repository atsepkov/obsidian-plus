import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type ObsidianPlus from './main';

export const TASK_OUTLINE_VIEW = 'task-outline-view';

export class TaskOutlineView extends ItemView {
    private plugin: ObsidianPlus;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianPlus) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return TASK_OUTLINE_VIEW;
    }

    getDisplayText() {
        return 'Task Outline';
    }

    getIcon() {
        return 'list-check';
    }

    async onOpen() {
        await this.updateView();
    }

    async updateView() {
        console.log('Updating task outline view');
        const container = this.containerEl;
        container.empty();
        const tag = (this.plugin as any).getTagUnderCursor();
        if (!tag) {
            container.createEl('p', { text: 'No tag at cursor.' });
            return;
        }
        const dv = (this.plugin.app as any).plugins.plugins['dataview']?.api;
        if (!dv || !this.plugin.tagQuery) {
            container.createEl('p', { text: 'Dataview plugin not available.' });
            return;
        }
        const items: any[] = await this.plugin.tagQuery.query(dv, tag, { onlyReturn: true }) as any[];
        // Subject inference is ON by default in the outline view, where context matters most.
        if (items) {
            await this.plugin.tagQuery.attachInferredSubjects(items, { inferSubject: true });
        }
        container.createEl('h3', { text: `Tasks for ${tag}` });
        const ul = container.createEl('ul');
        if (items) {
            for (const item of items) {
                const li = ul.createEl('li');
                const subject = item.__subject?.subject;
                if (subject) {
                    li.createEl('span', { text: subject, cls: 'op-inferred-subject', attr: { 'data-style': item.__subject.style } });
                    li.appendText(' ' + item.text);
                } else {
                    li.setText(item.text);
                }
            }
        }
    }

    async onClose() {}
}