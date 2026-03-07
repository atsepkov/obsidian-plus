/**
 * Extensions to Obsidian's type definitions
 * These properties exist at runtime but aren't in the official type definitions
 */
import 'obsidian';

declare module 'obsidian' {
    interface App {
        plugins: {
            plugins: Record<string, any>;
            getPlugin(id: string): any;
            enabledPlugins: Set<string>;
            manifests: Record<string, any>;
            enablePlugin(id: string): Promise<void>;
            disablePlugin(id: string): Promise<void>;
        };
    }

    interface MetadataCache {
        /** Get all tags in the vault with their occurrence counts (Obsidian ≥ 1.4) */
        getTags(): Record<string, number> | null;
    }

    interface Workspace {
        activeEditor: {
            editor: Editor;
        } | null;
    }

    interface FuzzySuggestModal<T> {
        chooser: {
            selectedItem: number;
            setSelectedItem(index: number): void;
            useSelectedItem(event: KeyboardEvent): void;
        };
        updateSuggestions(): void;
    }

    interface Editor {
        /** CodeMirror 6 editor view (provided by Obsidian at runtime) */
        cm: any;
    }
}

/**
 * Global types available in Obsidian environment
 * moment is provided by Obsidian globally
 */
declare global {
    const moment: any;
    interface Window {
        moment: typeof moment;
    }
}

/**
 * TurndownService for HTML to Markdown conversion
 */
declare class TurndownService {
    constructor(options?: {
        headingStyle?: 'setext' | 'atx';
        hr?: string;
        bulletListMarker?: '-' | '+' | '*';
        codeBlockStyle?: 'indented' | 'fenced';
        fence?: '```' | '~~~';
        emDelimiter?: '_' | '*';
        strongDelimiter?: '__' | '**';
        linkStyle?: 'inlined' | 'referenced';
        linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';
    });
    turndown(html: string | HTMLElement): string;
    addRule(key: string, rule: any): this;
    keep(filter: string | string[] | ((node: Node) => boolean)): this;
    remove(filter: string | string[] | ((node: Node) => boolean)): this;
    escape(text: string): string;
}
