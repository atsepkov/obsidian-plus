/**
 * Type declarations for obsidian-dataview plugin
 * The plugin is loaded dynamically at runtime via app.plugins.plugins["dataview"]
 */
declare module 'obsidian-dataview' {
    export interface DataviewApi {
        pages(source?: string): any;
        page(path: string): any;
        pagePaths(source?: string): string[];
        query(source: string): Promise<any>;
        queryMarkdown(source: string): Promise<any>;
        index: {
            tags: Map<string, Set<string>>;
        };
    }

    export interface Task {
        text: string;
        completed: boolean;
        path: string;
        line: number;
        position: { start: { line: number; col: number }; end: { line: number; col: number } };
        children: Task[];
        link: { path: string };
        tags: string[];
        outlinks: any[];
        status: string;
    }

    export interface ListItem {
        text: string;
        children: ListItem[];
        task?: boolean;
        line: number;
        lineCount: number;
        position: { start: { line: number; col: number }; end: { line: number; col: number } };
        path: string;
        link: { path: string };
        tags: string[];
        outlinks: any[];
        parent?: number;
        list?: number;
        status?: string;
        tagPosition?: number;
        completed?: boolean;
        parentItem?: ListItem;
        section?: { type: string; subpath: string };
    }
}
