/**
 * DSL Actions Module
 * 
 * Implements all built-in action handlers for the DSL system.
 * Each action receives the DSL context and returns an updated context.
 */

import { Notice, requestUrl, TFile } from 'obsidian';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
    DSLContext,
    ActionNode,
    ReadActionNode,
    FileActionNode,
    FetchActionNode,
    ShellActionNode,
    TransformActionNode,
    BuildActionNode,
    QueryActionNode,
    SetActionNode,
    MatchActionNode,
    IfActionNode,
    LogActionNode,
    NotifyActionNode,
    ExtractActionNode,
    ForeachActionNode,
    ReturnActionNode,
    AppendActionNode,
    TaskActionNode,
    ValidateActionNode,
    DelayActionNode,
    FilterActionNode,
    MapActionNode,
    DateActionNode,
    TransformChild,
    FileMetadata
} from './types';
import {
    extractValues,
    interpolate,
    interpolateToValue,
    interpolateWithFormatter,
    evaluateCondition,
    cleanTemplate
} from './patternMatcher';

const execAsync = promisify(exec);
const SHELL_MAX_BUFFER = 10 * 1024 * 1024;

async function appendChildBullet(context: DSLContext, text: string, bullet: '+' | '*', indentLevel = 1): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (context.task && context.taskManager) {
        await context.taskManager.updateDvTask(context.task, {
            appendChildren: [{
                indent: Math.max(0, indentLevel - 1),
                text: trimmed,
                bullet
            }],
            useBullet: bullet
        });
        return;
    }

    if (context.editor) {
        const editor = context.editor;
        const cursorLine = context.cursor?.line ?? editor.getCursor().line;
        const currentLine = editor.getLine(cursorLine);
        const baseIndent = currentLine.match(/^(\s*)/)?.[1] || '';
        const indentUnit = '  ';
        const childIndent = baseIndent + indentUnit.repeat(indentLevel);

        let insertLine = cursorLine;
        const totalLines = editor.lineCount();
        for (let i = cursorLine + 1; i < totalLines; i++) {
            const line = editor.getLine(i);
            const lineIndent = line.match(/^(\s*)/)?.[1] || '';
            if (lineIndent.length <= baseIndent.length && line.trim() !== '') {
                break;
            }
            if (line.trim() !== '') {
                insertLine = i;
            }
        }

        const newLine = `${childIndent}${bullet} ${trimmed}`;
        const insertPos = { line: insertLine, ch: editor.getLine(insertLine).length };
        editor.replaceRange('\n' + newLine, insertPos);

        const newCursorLine = insertLine + 1;
        editor.setCursor({ line: newCursorLine, ch: newLine.length });
        context.cursor = { line: newCursorLine, ch: newLine.length };
    }
}

function getVaultBasePath(context: DSLContext): string {
    const adapter = (context.app.vault as any)?.adapter;
    const basePath = typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : adapter?.basePath;

    if (!basePath || typeof basePath !== 'string') {
        throw new Error('shell: vault base path is unavailable; shell commands require a filesystem vault');
    }

    return basePath;
}

function ensureVaultScopedCommand(command: string): void {
    const tokens = command.split(/\s+/).filter(Boolean).map(t => t.replace(/^['"]|['"]$/g, ''));

    for (const token of tokens) {
        if (!token) continue;
        if (/^[A-Za-z]:\\/.test(token)) {
            throw new Error('shell: commands must stay within the vault (no absolute drive paths)');
        }
        if (token.startsWith('/') || token.startsWith('~')) {
            throw new Error('shell: commands must stay within the vault (no absolute paths). Symlink external folders into the vault if needed.');
        }
        if (token === '..' || token.startsWith('../') || token.includes('/../')) {
            throw new Error('shell: parent path segments are not allowed; use a vault symlink instead');
        }
    }
}

export function parseWikilink(raw: string): { path: string; anchor: string | null } {
    const s = (raw ?? '').trim();
    if (!s) return { path: '', anchor: null };

    // [[path|alias]] or [[path#anchor|alias]] -> extract path and anchor
    const bracket = s.match(/^\[\[([\s\S]+)\]\]$/);
    const inner = bracket ? bracket[1] : s;
    const beforeAlias = inner.split('|')[0].trim();

    // Split on # to get path and anchor
    const hashIndex = beforeAlias.indexOf('#');
    if (hashIndex >= 0) {
        return {
            path: beforeAlias.slice(0, hashIndex).trim(),
            anchor: beforeAlias.slice(hashIndex + 1).trim() || null
        };
    }
    return { path: beforeAlias, anchor: null };
}

export function resolveWikilinkToFile(context: DSLContext, wikilink: string): TFile {
    const { path } = parseWikilink(wikilink);
    if (!path) throw new Error('wikilink resolution requires a non-empty from: [[File]]');
    const basePath = context.file?.path ?? '';
    const dest = context.app.metadataCache.getFirstLinkpathDest(path, basePath);
    if (!dest) throw new Error(`Could not resolve wikilink: ${wikilink}`);
    return dest;
}

function buildFileMetadata(context: DSLContext, file: TFile): FileMetadata {
    const isMarkdown = (file.extension || '').toLowerCase() === 'md';
    const frontmatter = isMarkdown ? context.app.metadataCache.getFileCache(file)?.frontmatter ?? {} : {};

    return {
        path: file.path,
        name: file.name,
        basename: file.basename,
        extension: file.extension,
        resourcePath: context.app.vault.getResourcePath(file),
        frontmatter
    };
}

/**
 * Action handler type
 */
export type ActionHandler<T extends ActionNode = ActionNode> = (
    action: T,
    context: DSLContext,
    executeAction: (action: ActionNode, ctx: DSLContext) => Promise<DSLContext>
) => Promise<DSLContext>;

function stripMarkdownListPrefix(line: string): { indent: string; bullet: '-' | null; content: string } {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch?.[1] ?? '';

    // Matches:
    // - "- text"
    // - "- [ ] text"
    // - "- [x] text"
    // - "- [/] text"
    // - "- [-] text"
    // - "- [!] text"
    //
    // IMPORTANT: we intentionally do NOT match "*" or "+" bullets here; those have other meaning in this plugin.
    const m = line.match(/^(\s*)-\s+(?:\[[ xX\/!\-]\]\s+)?(.*)$/);
    if (!m) {
        // Return the original line so patterns like "#tag {{x}}" won't accidentally match "* #tag ..." or "+ #tag ..."
        return { indent, bullet: null, content: line };
    }

    return { indent: m[1] ?? indent, bullet: '-', content: m[2] ?? '' };
}

/**
 * Read action handler
 * Reads content and extracts variables based on pattern
 */
export const readAction: ActionHandler<ReadActionNode> = async (action, context) => {
    const source = action.source || 'line';
    let text: string;
    let textForMatching: string | null = null;
    
    const stripFrontmatter = (md: string): { frontmatter: any | null; body: string } => {
        // Standard YAML frontmatter: starts at beginning of file with ---\n and ends with \n---\n
        if (!md.startsWith('---\n')) return { frontmatter: null, body: md };
        const end = md.indexOf('\n---', 4);
        if (end === -1) return { frontmatter: null, body: md };
        const body = md.slice(end + '\n---'.length).replace(/^\r?\n/, '');
        return { frontmatter: null, body };
    };

    const slugifyHeading = (value: string): string => {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-');
    };

    const findHeadingLine = (file: TFile, lines: string[], anchor: string): { index: number; level: number } | null => {
        const normalizedAnchor = slugifyHeading(anchor.replace(/^#/, ''));
        const cache = context.app.metadataCache.getFileCache(file);

        // Try to find heading using metadataCache
        if (cache?.headings?.length) {
            for (const heading of cache.headings) {
                if (!heading?.heading) continue;
                const headingText = heading.heading.trim();
                const slug = slugifyHeading(headingText);
                if (slug === normalizedAnchor || headingText.toLowerCase() === anchor.trim().toLowerCase()) {
                    const index = heading.position?.start?.line ?? heading.position?.line ?? -1;
                    if (index >= 0) {
                        return { index, level: heading.level ?? 1 };
                    }
                }
            }
        }

        // Fallback: scan lines manually
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(#+)\s+(.*)$/);
            if (!match) continue;
            const headingText = match[2].trim();
            const slug = slugifyHeading(headingText);
            if (slug === normalizedAnchor || headingText.toLowerCase() === anchor.trim().toLowerCase()) {
                return { index: i, level: match[1].length };
            }
        }

        return null;
    };

    const extractHeadingSectionFromLines = (lines: string[], startLine: number, level: number): string => {
        const result: string[] = [];
        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];
            if (i > startLine) {
                const match = line.match(/^(#+)\s+/);
                if (match && match[1].length <= level) {
                    break;
                }
            }
            result.push(line);
        }
        return result.join('\n');
    };

    const isImageFile = (file: TFile): boolean => {
        const ext = file.extension.toLowerCase();
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
    };

    const getMimeType = (file: TFile): string => {
        const ext = file.extension.toLowerCase();
        const mimeTypes: Record<string, string> = {
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'bmp': 'image/bmp'
        };
        return mimeTypes[ext] || 'image/png';
    };

    const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    switch (source) {
        case 'line':
            text = context.line || '';
            // For matching patterns like "#podcast {{url}}", ignore list prefix/checkbox.
            // This allows matching both "- #podcast ..." and indented variants.
            {
                const stripped = stripMarkdownListPrefix(text);
                textForMatching = stripped.bullet === '-' ? stripped.content : null;
            }
            break;
        case 'file':
            if (context.file) {
                text = await context.app.vault.read(context.file);
            } else {
                throw new Error('No file available in context');
            }
            break;
        case 'wikilink': {
            const from = action.from ? interpolate(action.from, context.vars) : '';
            const { path, anchor } = parseWikilink(from);
            if (!path) throw new Error('read: source=wikilink requires a non-empty from: [[File]]');

            const file = resolveWikilinkToFile(context, from);

            const fileVar = action.asFile ?? 'fromFile';
            context.vars[fileVar] = buildFileMetadata(context, file);

            const fullText = await context.app.vault.read(file);
            
            // If anchor is specified, extract just that section
            if (anchor) {
                const lines = fullText.split('\n');
                const headingInfo = findHeadingLine(file, lines, anchor);
                if (headingInfo) {
                    text = extractHeadingSectionFromLines(lines, headingInfo.index, headingInfo.level);
                } else {
                    throw new Error(`Could not find section "${anchor}" in file ${file.name}`);
                }
            } else {
                text = fullText;
            }

            if (action.includeFrontmatter) {
                const fm = context.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
                const fmVar = action.frontmatterAs || 'frontmatter';
                context.vars[fmVar] = fm;
            }

            if (action.stripFrontmatter) {
                text = stripFrontmatter(text).body;
            }
            break;
        }
        case 'selection':
            if (context.editor) {
                text = context.editor.getSelection() || context.line || '';
            } else {
                text = context.line || '';
            }
            break;
        case 'children':
            // Read children of the current task (task context) OR current editor line (onEnter editor context)
            {
                let lines: string[] = [];
                if (context.task && context.taskManager) {
                    const children = await context.taskManager.getDvTaskChildren(context.task);
                    lines = children.map(c => c.text).filter(Boolean);
                } else if (context.editor) {
                    // Scan editor lines below current cursor line until indentation resets
                    const editor = context.editor;
                    const cursorLine = context.cursor?.line ?? editor.getCursor().line;
                    const parentLine = editor.getLine(cursorLine);
                    const baseIndent = parentLine.match(/^(\s*)/)?.[1] ?? '';
                    const total = editor.lineCount();
                    for (let i = cursorLine + 1; i < total; i++) {
                        const l = editor.getLine(i);
                        const lIndent = l.match(/^(\s*)/)?.[1] ?? '';
                        if (lIndent.length <= baseIndent.length && l.trim() !== '') break;
                        if (l.trim() !== '') {
                            lines.push(l);
                        }
                    }
                }

                // Store raw children lines
                const linesVar = action.childrenLinesAs || 'childrenLines';
                context.vars[linesVar] = lines;

                // Build a normalized "text" version
                text = lines.join('\n');

                // Build object view (only for "key: value" lines, ignore others)
                const objVar = action.childrenAs || 'children';
                const obj: Record<string, any> = {};
                for (const rawLine of lines) {
                    // In task context, lines may already be plain; in editor context they include bullets.
                    const stripped = stripMarkdownListPrefix(rawLine);
                    const content = stripped.bullet === '-' ? stripped.content : rawLine.trim();
                    const idx = content.indexOf(':');
                    if (idx === -1) continue;
                    const key = content.slice(0, idx).trim();
                    const value = content.slice(idx + 1).trim();
                    if (!key || !value) continue;
                    obj[key] = cleanTemplate(value);
                }
                context.vars[objVar] = obj;
            }
            break;
        case 'image': {
            const from = action.from ? interpolate(action.from, context.vars) : '';
            if (!from) throw new Error('read: source=image requires a non-empty from: value');
            
            // Check if it's an external URL
            const isExternalUrl = /^https?:\/\//i.test(from.trim());
            
            if (isExternalUrl) {
                // External URL: pass through or convert based on format
                const url = from.trim();
                const format = action.format || 'url';
                if (format === 'url') {
                    text = url;
                } else {
                    // For external URLs, we'd need to fetch and convert
                    // For now, just return the URL (user can fetch separately if needed)
                    text = url;
                }
            } else {
                // Wikilink: resolve to file and convert to base64
                // Handle both ![[image.png]] and [[image.png]] formats
                const wikilink = from.replace(/^!\[\[/, '[[').replace(/\]\]$/, ']]');
                const file = resolveWikilinkToFile(context, wikilink);

                const fileVar = action.asFile ?? 'fromFile';
                context.vars[fileVar] = buildFileMetadata(context, file);
                
                if (!isImageFile(file)) {
                    throw new Error(`read: source=image - file "${file.name}" is not a recognized image file (supported: png, jpg, jpeg, gif, webp, svg, bmp)`);
                }
                
                // Read binary data
                const arrayBuffer = await context.app.vault.adapter.readBinary(file.path);
                const base64 = arrayBufferToBase64(arrayBuffer);
                
                // Format output based on format option
                const format = action.format || 'dataUri';
                if (format === 'base64') {
                    text = base64;
                } else if (format === 'dataUri') {
                    const mimeType = getMimeType(file);
                    text = `data:${mimeType};base64,${base64}`;
                } else {
                    // 'url' format - return resource path (though this is less useful for external APIs)
                    text = context.app.vault.getResourcePath(file);
                }
            }
            break;
        }
        default:
            text = context.line || '';
    }
    
    const stripTaskMetadata = (content: string): string => {
        // Remove trailing task metadata tokens (e.g., completion/due dates like "✅ 2025-12-21").
        // This keeps pattern matching focused on the user-provided text rather than auto-appended status fields.
        const metadataPattern = /\s*(?:[✅⏳📅🔁🛫🛬🚩]\s+[^\s]+(?:\s+[^\s]+)*)$/;
        let result = content.trimEnd();

        while (metadataPattern.test(result)) {
            result = result.replace(metadataPattern, '').trimEnd();
        }

        return result;
    };

    // Extract variables from text using pattern (skip for images - they're binary)
    if (action.pattern && source !== 'image') {
        // IMPORTANT: Do NOT interpolate patterns used for extraction.
        // Interpolation would delete capture tokens (e.g. {{url}}) when vars are unset,
        // turning "#podcast {{url}}" into "#podcast " and causing false mismatches.
        const pattern = action.pattern;
        const haystack = stripTaskMetadata(textForMatching ?? text);
        const result = extractValues(haystack, pattern);
        
        if (result.success) {
            // Merge extracted values into context
            context.vars = { ...context.vars, ...result.values };
        } else {
            // High-signal debug to diagnose unexpected mismatches
            console.warn('[DSL][read] Pattern mismatch', {
                pattern,
                haystack,
                rawLine: text,
                haystackPrefixCodes: haystack.slice(0, 8).split('').map(c => c.charCodeAt(0)),
                rawPrefixCodes: text.slice(0, 8).split('').map(c => c.charCodeAt(0))
            });
            throw new Error(result.error || 'Pattern extraction failed');
        }
    }
    
    // Always store the raw text
    context.vars.text = text;
    if (textForMatching !== null) {
        context.vars.textContent = textForMatching;
    }

    // If requested, store into a named variable too
    if (action.as) {
        context.vars[action.as] = text;
    }
    
    return context;
};

/**
 * File action handler
 * Resolves a wikilink/path to a vault file and exposes its metadata for downstream actions
 */
export const fileAction: ActionHandler<FileActionNode> = async (action, context) => {
    const from = interpolate(action.from, context.vars).trim();
    if (!from) throw new Error('file: requires a from value (wikilink or path)');

    const file = resolveWikilinkToFile(context, from);
    const varName = action.as?.trim();
    if (!varName) throw new Error('file: requires as: <variable> to store metadata');

    context.vars[varName] = buildFileMetadata(context, file);
    return context;
};

/**
 * Fetch action handler
 * Makes HTTP requests and stores response
 */
export const fetchAction: ActionHandler<FetchActionNode> = async (action, context) => {
    // Interpolate URL with context variables
    const url = interpolate(action.url, context.vars);
    
    console.log('[DSL][fetch] Starting fetch', {
        rawUrl: action.url,
        interpolatedUrl: url,
        method: action.method || 'GET',
        as: action.as
    });
    
    // Validate URL
    if (!url || url.includes('{{')) {
        const error = `Invalid URL after interpolation: "${url}" (original: "${action.url}")`;
        console.error('[DSL][fetch] URL interpolation failed:', error);
        throw new Error(error);
    }
    
    // Build headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ObsidianPlus/1.0'
    };
    
    // Add configured headers
    if (action.headers) {
        for (const [key, value] of Object.entries(action.headers)) {
            headers[key] = interpolate(value, context.vars);
        }
    }
    
    // Add authentication
    if (action.auth) {
        switch (action.auth.type) {
            case 'basic':
                if (action.auth.username && action.auth.password) {
                    const username = interpolate(action.auth.username, context.vars);
                    const password = interpolate(action.auth.password, context.vars);
                    const credentials = btoa(`${username}:${password}`);
                    headers['Authorization'] = `Basic ${credentials}`;
                }
                break;
            case 'bearer':
                if (action.auth.token) {
                    const token = interpolate(action.auth.token, context.vars);
                    headers['Authorization'] = `Bearer ${token}`;
                }
                break;
            case 'apiKey':
                if (action.auth.apiKey) {
                    const headerName = action.auth.headerName || 'X-API-Key';
                    headers[headerName] = interpolate(action.auth.apiKey, context.vars);
                }
                break;
        }
    }
    
    // Build request body
    let body: string | undefined;
    if (action.body && action.method !== 'GET') {
        const interpolatedBody = interpolate(action.body, context.vars);
        // Check if it's a variable reference to an object
        if (interpolatedBody.startsWith('{') || interpolatedBody.startsWith('[')) {
            body = interpolatedBody;
        } else {
            // It might be a variable name
            const bodyVar = context.vars[action.body];
            if (bodyVar && typeof bodyVar === 'object') {
                body = JSON.stringify(bodyVar);
            } else {
                body = interpolatedBody;
            }
        }
    }
    
    // Make the request using Obsidian's requestUrl
    console.log('[DSL][fetch] Making request to:', url);
    let response;
    try {
        response = await requestUrl({
            url,
            method: action.method || 'GET',
            headers,
            body,
            throw: false
        });
    } catch (reqError) {
        console.error('[DSL][fetch] Request threw exception:', reqError);
        throw new Error(`Network request failed: ${reqError instanceof Error ? reqError.message : String(reqError)}`);
    }
    
    console.log('[DSL][fetch] Response status:', response.status, 'headers:', response.headers);
    
    if (response.status < 200 || response.status >= 300) {
        const errorMsg = `HTTP ${response.status}: ${response.text?.slice(0, 200) || 'Request failed'}`;
        console.error('[DSL][fetch] HTTP error:', errorMsg);
        throw new Error(errorMsg);
    }
    
    // Parse response
    let responseData: any;
    const contentType = response.headers['content-type'] || '';
    
    // Try to parse as JSON if content-type suggests JSON, or if response looks like JSON
    const isJsonContentType = contentType.includes('application/json') || 
                               contentType.includes('text/javascript') ||
                               contentType.includes('application/javascript');
    
    if (isJsonContentType) {
        try {
            responseData = response.json;
            console.log('[DSL][fetch] Parsed JSON response:', JSON.stringify(responseData).slice(0, 500));
        } catch {
            // If response.json fails, try parsing response.text
            try {
                responseData = JSON.parse(response.text);
                console.log('[DSL][fetch] Parsed JSON from text');
            } catch {
                responseData = response.text;
                console.log('[DSL][fetch] Failed to parse JSON, using text');
            }
        }
    } else {
        // Try to parse as JSON anyway (many APIs return JSON with wrong content-type)
        // Check if response looks like JSON (starts with { or [)
        const text = response.text || '';
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
                responseData = JSON.parse(text);
                console.log('[DSL][fetch] Parsed as JSON despite content-type');
            } catch {
                responseData = text;
                console.log('[DSL][fetch] Failed to parse as JSON, using text');
            }
        } else {
            responseData = text;
            console.log('[DSL][fetch] Non-JSON response, using text');
        }
    }
    
    // Store response
    context.response = responseData;
    context.vars.response = responseData;
    
    if (action.as) {
        context.vars[action.as] = responseData;
        console.log('[DSL][fetch] Stored response as:', action.as);
    }
    
    return context;
};

/**
 * Shell action handler
 * Executes a command scoped to the vault root and surfaces output as + children
 */
export const shellAction: ActionHandler<ShellActionNode> = async (action, context) => {
    const interpolated = interpolateWithFormatter(action.command, context.vars, value => {
        const str = typeof value === 'object'
            ? (() => { try { return JSON.stringify(value); } catch { return String(value); } })()
            : String(value);

        // Escape characters that would break quoted shell commands while preserving user-provided quotes.
        return str.replace(/(["`\\$])/g, '\\$1');
    });
    const command = interpolated.replace(/[\r\n]+/g, ' ').trim();
    if (!command) throw new Error('shell: command is empty after interpolation');

    ensureVaultScopedCommand(command);
    const cwd = getVaultBasePath(context);

    try {
        const result = await execAsync(command, {
            cwd,
            timeout: action.timeout,
            windowsHide: true,
            maxBuffer: SHELL_MAX_BUFFER
        });

        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        if (action.as) {
            context.vars[action.as] = output;
        }

        if (output) {
            await appendChildBullet(context, output, '+');
        }

        return context;
    } catch (err: any) {
        const stdout = err?.stdout ?? '';
        const stderr = err?.stderr ?? '';
        const combined = `${stdout}${stderr}`.trim();
        const codeInfo = err?.code !== undefined ? `exit ${err.code}` : (err?.signal ? `signal ${err.signal}` : 'failed');
        const message = combined ? `${combined} (${codeInfo})` : `Command failed (${codeInfo})`;
        throw new Error(`shell failed: ${message}`);
    }
};

/**
 * Transform action handler
 * Modifies line content and adds children
 */
export const transformAction: ActionHandler<TransformActionNode> = async (action, context) => {
    console.log('[DSL][transform] Starting transform action', {
        hasTask: Boolean(context.task),
        hasTaskManager: Boolean(context.taskManager),
        hasEditor: Boolean(context.editor),
        hasTemplate: Boolean(action.template),
        hasChildTemplates: Boolean(action.childTemplates?.length),
        childTemplatesCount: action.childTemplates?.length ?? 0
    });
    
    if (!context.task || !context.taskManager) {
        // For non-task contexts (like onEnter), we work with the editor directly
        if (context.editor) {
            console.log('[DSL][transform] Using editor context (onEnter)');
            return transformWithEditor(action, context);
        }
        throw new Error('No task or editor available for transform');
    }
    
    // Build update options for taskManager
    const updateOptions: any = {};
    
    if (action.template) {
        const newText = interpolate(action.template, context.vars);
        
        switch (action.mode) {
            case 'append':
                updateOptions.append = newText;
                break;
            case 'prepend':
                updateOptions.prepend = newText;
                break;
            case 'replace':
            default:
                updateOptions.replace = newText;
                break;
        }
    }
    
    // Build children from templates
    if (action.childTemplates && action.childTemplates.length > 0) {
        const children = buildTransformChildren(action.childTemplates, context);
        updateOptions.appendChildren = children;
    }
    
    // Apply the update
    await context.taskManager.updateDvTask(context.task, updateOptions);
    
    return context;
};

/**
 * Transform using editor for non-task contexts (like onEnter)
 */
async function transformWithEditor(action: TransformActionNode, context: DSLContext): Promise<DSLContext> {
    const editor = context.editor;
    if (!editor) {
        throw new Error('No editor available for transform');
    }
    
    console.log('[DSL][transform] transformWithEditor called', {
        hasTemplate: Boolean(action.template),
        hasChildTemplates: Boolean(action.childTemplates?.length),
        childTemplatesCount: action.childTemplates?.length ?? 0,
        contextVars: Object.keys(context.vars)
    });
    
    const cursor = editor.getCursor();
    const currentLine = editor.getLine(cursor.line);
    const indent = currentLine.match(/^(\s*)/)?.[1] || '';
    // Only preserve "-" bullets for transform output. If the line isn't a "-" bullet, default to "-".
    const bulletMatch = currentLine.match(/^(\s*)-\s+/);
    const bullet = bulletMatch ? '-' : '-';
    
    console.log('[DSL][transform] Current line context', {
        cursorLine: cursor.line,
        cursorCh: cursor.ch,
        currentLine,
        indent,
        bullet
    });
    
    // Build the new content
    let newLines: string[] = [];
    
    // If no inline template was provided, treat the FIRST child template as the replacement line.
    // This matches the intended DSL UX:
    // - transform:
    //   - #podcast {{meta.title}}
    //     - url: ...
    //     - channel: ...
    //     - {{cursor}}
    let childTemplates = action.childTemplates ?? [];
    if (!action.template && childTemplates.length > 0) {
        const first = childTemplates[0];
        const firstText = interpolate(first.template, context.vars);
        // Replace current line with first child as the "main" line
        // Preserve {{cursor}} for position calculation - will be stripped later
        newLines.push(`${indent}${bullet} ${firstText}`);
        // Remaining children become appended under it. Also include any nested children of the first child.
        const rest: TransformChild[] = [];
        if (first.children && first.children.length > 0) {
            rest.push(...first.children);
        }
        rest.push(...childTemplates.slice(1));
        childTemplates = rest;
    } else if (action.template) {
        const newText = interpolate(action.template, context.vars);
        // Preserve {{cursor}} for position calculation - will be stripped later
        newLines.push(`${indent}${bullet} ${newText}`);
    } else {
        // Keep the current line if no template and no children
        newLines.push(currentLine);
    }
    
    // Add children
    if (childTemplates && childTemplates.length > 0) {
        const childLines = buildTransformChildrenAsLines(childTemplates, context, indent);
        newLines.push(...childLines);
    }
    
    // Find cursor position in the output
    let cursorLine = cursor.line;
    let cursorCh = cursor.ch;
    
    let fullText = newLines.join('\n');
    const cursorMarkerIndex = fullText.indexOf('{{cursor}}');
    
    console.log('[DSL][transform] Cursor marker search', {
        fullTextLength: fullText.length,
        cursorMarkerIndex,
        fullTextPreview: fullText.slice(0, 300)
    });
    
    if (cursorMarkerIndex !== -1) {
        // Calculate cursor position from marker
        const beforeCursor = fullText.substring(0, cursorMarkerIndex);
        const linesBeforeCursor = beforeCursor.split('\n');
        cursorLine = cursor.line + linesBeforeCursor.length - 1;
        cursorCh = linesBeforeCursor[linesBeforeCursor.length - 1].length;
        
        console.log('[DSL][transform] Cursor position calculated', {
            targetLine: cursorLine,
            targetCh: cursorCh,
            linesBeforeCursor: linesBeforeCursor.length
        });
        
        // Remove cursor marker from the text
        fullText = fullText.replace('{{cursor}}', '');
        newLines = fullText.split('\n');
    }
    
    // Replace current line with new content (single-line replace)
    const startPos = { line: cursor.line, ch: 0 };
    const endPos = { line: cursor.line, ch: currentLine.length };
    
    console.log('[DSL][transform] Replacing range', {
        startPos,
        endPos,
        newLinesCount: newLines.length,
        output: newLines.join('\n').slice(0, 300)
    });
    
    editor.replaceRange(newLines.join('\n'), startPos, endPos);
    
    // Set cursor position
    context.cursor = { line: cursorLine, ch: cursorCh };
    editor.setCursor(cursorLine, cursorCh);
    
    return context;
}

/**
 * Build transform children for task update
 */
function buildTransformChildren(
    templates: TransformChild[],
    context: DSLContext,
    baseIndent: number = 0
): any[] {
    const results: any[] = [];
    
    for (const template of templates) {
        const text = interpolate(template.template, context.vars);
        
        // Skip empty lines, but keep {{cursor}} placeholder for position tracking
        if (text === '') {
            continue;
        }
        
        // For {{cursor}}, create an empty line where cursor will be placed
        const finalText = text === '{{cursor}}' ? '' : text.replace('{{cursor}}', '').trim();
        
        const child: any = {
            indent: baseIndent + template.indent,
            text: finalText
        };
        
        if (template.children && template.children.length > 0) {
            // Recursively build nested children
            const nestedChildren = buildTransformChildren(
                template.children,
                context,
                baseIndent + template.indent + 1
            );
            if (nestedChildren.length > 0) {
                results.push(child, ...nestedChildren);
            } else {
                results.push(child);
            }
        } else {
            results.push(child);
        }
    }
    
    return results;
}

/**
 * Build transform children as plain text lines
 * NOTE: This preserves {{cursor}} markers - caller is responsible for finding position and removing them
 */
function buildTransformChildrenAsLines(
    templates: TransformChild[],
    context: DSLContext,
    baseIndent: string
): string[] {
    const lines: string[] = [];
    const indentUnit = '  '; // 2 spaces per indent level
    
    for (const template of templates) {
        const text = interpolate(template.template, context.vars);
        const indent = baseIndent + indentUnit.repeat(template.indent + 1);
        
        // For standalone {{cursor}} line, create an empty bullet where cursor will land
        if (text === '{{cursor}}') {
            lines.push(`${indent}- {{cursor}}`);
        } else if (text !== '') {
            // Preserve {{cursor}} in the line for position calculation (don't strip here)
            lines.push(`${indent}- ${text}`);
        }
        
        if (template.children && template.children.length > 0) {
            const childLines = buildTransformChildrenAsLines(
                template.children,
                context,
                indent
            );
            lines.push(...childLines);
        }
    }
    
    return lines;
}

/**
 * Build action handler
 * Constructs a JSON object from key-value pairs
 */
export const buildAction: ActionHandler<BuildActionNode> = async (action, context) => {
    const obj: Record<string, any> = {};
    
    if (action.properties) {
        for (const [key, valueTemplate] of Object.entries(action.properties)) {
            const value = interpolate(valueTemplate, context.vars);
            
            // Try to parse as JSON for arrays/objects
            try {
                obj[key] = JSON.parse(value);
            } catch {
                obj[key] = value;
            }
        }
    }
    
    context.vars[action.name] = obj;
    
    return context;
};

/**
 * Query action handler
 * Queries tasks via TagQuery
 */
export const queryAction: ActionHandler<QueryActionNode> = async (action, context) => {
    if (!context.tagQuery || !context.dv) {
        throw new Error('TagQuery or Dataview not available');
    }
    
    const identifier = interpolate(action.identifier, context.vars);
    const options = action.options ? { ...action.options } : {};
    
    // Add onlyReturn to get results instead of rendering
    options.onlyReturn = true;
    
    const results = await context.tagQuery.query(context.dv, identifier, options);
    
    const varName = action.as || 'results';
    context.vars[varName] = results;
    
    return context;
};

/**
 * Set action handler
 * Sets a variable in context
 */
export const setAction: ActionHandler<SetActionNode> = async (action, context) => {
    const rawValue = interpolateToValue(action.value, context.vars);
    const value = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);

    // If pattern is provided, extract using pattern (like read does)
    if (action.pattern) {
        const result = extractValues(value, action.pattern);
        if (!result.success) {
            throw new Error(result.error || `Pattern extraction failed for set: ${action.pattern}`);
        }
        // Store all extracted variables into context
        context.vars = { ...context.vars, ...result.values };
        // If pattern extracted a variable matching action.name, use that; otherwise use first extracted
        const extractedVarNames = Object.keys(result.values);
        if (extractedVarNames.length > 0) {
            // Prefer extracted variable with same name as target, otherwise use first
            const matchingVar = extractedVarNames.find(v => v === action.name);
            context.vars[action.name] = matchingVar
                ? result.values[matchingVar]
                : result.values[extractedVarNames[0]];
        }
    } else {
        // Original behavior: try JSON parse, fallback to string
        if (typeof rawValue === 'string') {
            try {
                context.vars[action.name] = JSON.parse(rawValue);
            } catch {
                context.vars[action.name] = rawValue;
            }
        } else {
            context.vars[action.name] = rawValue;
        }
    }

    return context;
};

/**
 * Match action handler
 * Extracts patterns from text
 */
export const matchAction: ActionHandler<MatchActionNode> = async (action, context) => {
    const text = interpolate(action.in, context.vars);
    const pattern = action.pattern;
    
    const result = extractValues(text, pattern);
    
    if (result.success) {
        context.vars = { ...context.vars, ...result.values };
    } else {
        throw new Error(result.error || 'Pattern match failed');
    }
    
    return context;
};

/**
 * If action handler
 * Conditional execution
 */
export const ifAction: ActionHandler<IfActionNode> = async (action, context, executeAction) => {
    const conditionResult = evaluateCondition(action.condition, context.vars);
    
    const actionsToExecute = conditionResult ? action.then : (action.else || []);
    
    for (const childAction of actionsToExecute) {
        if (context.shouldReturn) break;
        context = await executeAction(childAction, context);
    }
    
    return context;
};

/**
 * Log action handler
 * Debug logging to console
 */
export const logAction: ActionHandler<LogActionNode> = async (action, context) => {
    const message = interpolate(action.message, context.vars);
    console.log('[DSL]', message);
    return context;
};

/**
 * Notify action handler
 * Shows Obsidian notice
 */
export const notifyAction: ActionHandler<NotifyActionNode> = async (action, context) => {
    const message = interpolate(action.message, context.vars);
    new Notice(message, action.duration || 4000);
    return context;
};

/**
 * Extract action handler
 * Regex extraction from text
 */
export const extractAction: ActionHandler<ExtractActionNode> = async (action, context) => {
    const text = interpolate(action.from, context.vars);
    
    // Parse regex pattern (handle /pattern/flags format)
    let regexPattern = action.pattern;
    let flags = 'g';
    
    const regexMatch = action.pattern.match(/^\/(.+)\/([gimsu]*)$/);
    if (regexMatch) {
        regexPattern = regexMatch[1];
        flags = regexMatch[2] || 'g';
    }
    
    const regex = new RegExp(regexPattern, flags);
    const matches = text.match(regex);
    
    const varName = action.as || 'matches';
    context.vars[varName] = matches || [];
    
    // Also store named groups if any
    const namedMatch = regex.exec(text);
    if (namedMatch?.groups) {
        context.vars = { ...context.vars, ...namedMatch.groups };
    }
    
    return context;
};

/**
 * Foreach action handler
 * Iterates over arrays
 */
export const foreachAction: ActionHandler<ForeachActionNode> = async (action, context, executeAction) => {
    const items = context.vars[action.items];
    
    if (!Array.isArray(items)) {
        throw new Error(`Variable '${action.items}' is not an array`);
    }
    
    const itemVarName = action.as || 'item';
    
    // Save the anchor line before the loop so all appends use the same parent
    // This is critical for "foreach + append" to create siblings, not nested children
    const anchorLine = context.cursor?.line ?? context.editor?.getCursor().line;
    let lastCursor = context.cursor;
    
    for (let i = 0; i < items.length; i++) {
        if (context.shouldReturn) break;
        
        // Reset cursor to anchor before each iteration (so append scans from parent)
        if (anchorLine !== undefined) {
            context.cursor = { line: anchorLine, ch: 0 };
        }
        
        // Set iteration variables
        context.vars[itemVarName] = items[i];
        context.vars[`${itemVarName}_index`] = i;
        
        // Execute child actions
        for (const childAction of action.do) {
            if (context.shouldReturn) break;
            context = await executeAction(childAction, context);
        }
        
        // Save cursor position after this iteration
        lastCursor = context.cursor;
    }
    
    // After the loop, restore cursor to the last inserted position for natural continuation
    if (lastCursor) {
        context.cursor = lastCursor;
        if (context.editor) {
            context.editor.setCursor(lastCursor.line, lastCursor.ch);
        }
    }
    
    // Clean up iteration variables
    delete context.vars[itemVarName];
    delete context.vars[`${itemVarName}_index`];
    
    return context;
};

/**
 * Return action handler
 * Early exit from execution
 */
export const returnAction: ActionHandler<ReturnActionNode> = async (action, context) => {
    context.shouldReturn = true;
    
    if (action.value) {
        const value = interpolate(action.value, context.vars);
        try {
            context.returnValue = JSON.parse(value);
        } catch {
            context.returnValue = value;
        }
    }
    
    return context;
};

/**
 * Validate action handler
 * Asserts a condition; throws with a user-friendly message when it fails.
 */
export const validateAction: ActionHandler<ValidateActionNode> = async (action, context) => {
    const message = action.message ? interpolate(action.message, context.vars) : undefined;

    // Evaluate:
    // - If condition looks like a comparison, use evaluateCondition
    // - Otherwise, treat interpolated value as truthy/falsy
    let ok = false;
    try {
        const hasOperator = /==|!=|>=|<=|>|</.test(action.condition);
        if (hasOperator) {
            ok = evaluateCondition(action.condition, context.vars);
        } else {
            const val = interpolate(action.condition, context.vars);
            ok = Boolean(val) && val !== 'false' && val !== '0' && val !== 'null' && val !== 'undefined';
        }
    } catch (e) {
        // Missing required variables etc.
        ok = false;
        if (!message) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw err;
        }
    }

    if (!ok) {
        throw new Error(message || `Validation failed: ${action.condition}`);
    }

    return context;
};

/**
 * Delay action handler
 * Pauses execution for a duration.
 */
export const delayAction: ActionHandler<DelayActionNode> = async (action, context) => {
    const raw = interpolate(action.duration, context.vars).trim();
    const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
    if (!m) throw new Error(`Invalid delay duration: ${raw}`);
    const n = Number(m[1]);
    const unit = (m[2] || 'ms').toLowerCase();
    const ms = unit === 'm' ? n * 60_000 : unit === 's' ? n * 1_000 : n;
    await new Promise<void>(resolve => window.setTimeout(resolve, ms));
    return context;
};

/**
 * Filter action handler
 */
export const filterAction: ActionHandler<FilterActionNode> = async (action, context) => {
    const items = context.vars[action.items];
    if (!Array.isArray(items)) {
        throw new Error(`Variable '${action.items}' is not an array`);
    }
    const outVar = action.as || `${action.items}_filtered`;
    const itemVar = action.itemAs || 'item';
    const kept: any[] = [];

    for (let i = 0; i < items.length; i++) {
        context.vars[itemVar] = items[i];
        context.vars[`${itemVar}_index`] = i;
        const ok = evaluateCondition(action.where, context.vars);
        if (ok) kept.push(items[i]);
    }

    delete context.vars[itemVar];
    delete context.vars[`${itemVar}_index`];
    context.vars[outVar] = kept;
    return context;
};

/**
 * Map action handler
 */
export const mapAction: ActionHandler<MapActionNode> = async (action, context) => {
    const items = context.vars[action.items];
    if (!Array.isArray(items)) {
        throw new Error(`Variable '${action.items}' is not an array`);
    }
    const outVar = action.as || `${action.items}_mapped`;
    const itemVar = action.itemAs || 'item';
    const mapped: any[] = [];

    for (let i = 0; i < items.length; i++) {
        context.vars[itemVar] = items[i];
        context.vars[`${itemVar}_index`] = i;
        const rendered = interpolate(action.template, context.vars);
        // Try to parse JSON to allow mapping into objects/arrays when desired
        try {
            mapped.push(JSON.parse(rendered));
        } catch {
            mapped.push(rendered);
        }
    }

    delete context.vars[itemVar];
    delete context.vars[`${itemVar}_index`];
    context.vars[outVar] = mapped;
    return context;
};

/**
 * Date action handler
 */
export const dateAction: ActionHandler<DateActionNode> = async (action, context) => {
    const outVar = action.as || 'date';
    const format = action.format || 'epoch';
    let d: Date;

    if (action.mode === 'now') {
        d = new Date();
    } else {
        const from = action.from ? interpolate(action.from, context.vars) : '';
        const t = Date.parse(String(from));
        if (!Number.isFinite(t)) throw new Error(`Could not parse date: ${from}`);
        d = new Date(t);
    }

    let value: any;
    switch (format) {
        case 'unix':
            value = Math.floor(d.getTime() / 1000);
            break;
        case 'iso':
            value = d.toISOString();
            break;
        case 'date':
            // Prefer Obsidian's moment if available
            value = (window as any).moment ? (window as any).moment(d).format('YYYY-MM-DD') : d.toISOString().slice(0, 10);
            break;
        case 'epoch':
        default:
            value = d.getTime();
            break;
    }

    context.vars[outVar] = value;
    return context;
};

/**
 * Append action handler
 * Appends a child bullet to the current task/line
 */
export const appendAction: ActionHandler<AppendActionNode> = async (action, context) => {
    const content = interpolate(action.template, context.vars);
    const indentLevel = action.indent ?? 1;
    
    // If we have a task context, use taskManager to append child
    if (context.task && context.taskManager) {
        await context.taskManager.updateDvTask(context.task, {
            appendChildren: [{
                indent: indentLevel - 1, // taskManager uses 0-based indent
                text: content
            }]
            // Note: useBullet defaults to "-" in taskManager, which is fine for user-facing content
            // We only use "+" for connector-generated responses/errors, not for user workflows like shopping lists
        });
        return context;
    }
    
    // For editor context (like onEnter), append directly
    if (context.editor) {
        const editor = context.editor;
        
        // Use context.cursor if set (from previous transform/append), otherwise use editor cursor
        // This is critical for foreach loops that call append multiple times
        const cursorLine = context.cursor?.line ?? editor.getCursor().line;
        const currentLine = editor.getLine(cursorLine);
        const baseIndent = currentLine.match(/^(\s*)/)?.[1] || '';
        const indentUnit = '  '; // 2 spaces per indent level
        const childIndent = baseIndent + indentUnit.repeat(indentLevel);
        
        // Find the end of the current block (last child or current line)
        // IMPORTANT: don't "chase" trailing blank lines, otherwise we end up inserting the child
        // after a run of empty lines (and the leading '\n' creates an extra visible blank line).
        let insertLine = cursorLine; // last non-empty line within the block
        const totalLines = editor.lineCount();
        
        // Scan forward to find the last child at this or deeper indentation
        for (let i = cursorLine + 1; i < totalLines; i++) {
            const line = editor.getLine(i);
            const lineIndent = line.match(/^(\s*)/)?.[1] || '';
            if (lineIndent.length <= baseIndent.length && line.trim() !== '') {
                break;
            }
            if (line.trim() !== '') {
                insertLine = i;
            }
        }
        
        // Insert the new child line after the last child
        const newLine = `${childIndent}- ${content}`;
        const insertPos = { line: insertLine, ch: editor.getLine(insertLine).length };
        editor.replaceRange('\n' + newLine, insertPos);
        
        // Update BOTH context.cursor AND editor cursor so subsequent appends work correctly
        const newCursorLine = insertLine + 1;
        context.cursor = { line: newCursorLine, ch: newLine.length };
        editor.setCursor(newCursorLine, newLine.length);
        
        return context;
    }
    
    throw new Error('No task or editor available for append action');
};

/**
 * Task action handler
 * Safe task manipulation primitives:
 * - clear: remove children by bullet type (* errors, + responses)
 * - status: set task status marker
 * - append: append a generated child line (defaults to + bullet)
 */
export const taskAction: ActionHandler<TaskActionNode> = async (action, context) => {
    if (!context.task || !context.taskManager) {
        throw new Error('task: requires a task context');
    }

    if (action.op === 'clear') {
        const bullets = String(action.bullets ?? '').trim();
        if (!bullets) throw new Error('task clear: requires bullets (e.g. "*", "+", "*+")');
        if (bullets.includes('-')) throw new Error('task clear: refusing to remove "-" bullets (user-authored)');

        await context.taskManager.updateDvTask(context.task, {
            removeChildrenByBullet: bullets
        });
        return context;
    }

    if (action.op === 'status') {
        const to = String(action.toStatus ?? '').trim();
        if (!to) throw new Error('task status: requires to: (e.g. x, !, /, -, " ")');
        await context.taskManager.changeDvTaskStatus(context.task, to);
        return context;
    }

    if (action.op === 'append') {
        const tpl = String(action.template ?? '').trim();
        if (!tpl) throw new Error('task append: requires text/template');

        const indentLevel = action.indent ?? 1;
        const bullet = (action.bullet ?? '+').trim() || '+';
        if (bullet === '-') throw new Error('task append: refusing to use "-" bullet (user-authored)');
        if (bullet !== '+' && bullet !== '*') throw new Error(`task append: unsupported bullet "${bullet}" (use "+" or "*")`);

        await context.taskManager.updateDvTask(context.task, {
            appendChildren: [{
                indent: Math.max(0, indentLevel - 1),
                text: interpolate(tpl, context.vars),
                bullet
            }],
            useBullet: bullet
        });
        return context;
    }

    throw new Error(`task: unsupported op ${(action as any).op}`);
};

/**
 * Registry of all action handlers
 */
export const actionHandlers: Record<string, ActionHandler<any>> = {
    read: readAction,
    file: fileAction,
    fetch: fetchAction,
    shell: shellAction,
    transform: transformAction,
    build: buildAction,
    query: queryAction,
    set: setAction,
    match: matchAction,
    if: ifAction,
    log: logAction,
    notify: notifyAction,
    extract: extractAction,
    foreach: foreachAction,
    return: returnAction,
    append: appendAction,
    task: taskAction,
    validate: validateAction,
    delay: delayAction,
    filter: filterAction,
    map: mapAction,
    date: dateAction
};

/**
 * Get action handler by type
 */
export function getActionHandler(type: string): ActionHandler | undefined {
    return actionHandlers[type];
}

