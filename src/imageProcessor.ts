import { Notice, TFile, Vault, normalizePath } from 'obsidian';
import { DataviewApi, Task } from 'obsidian-dataview';

export class ImageProcessor {
    private vault: Vault;
    private dataview: DataviewApi;

    constructor(vault: Vault, dataview: DataviewApi) {
        this.vault = vault;
        this.dataview = dataview;
    }

    async processTaskImages(task: Task): Promise<void> {
        const noteFile = this.dataview.pageToFile(task.link.path);
        if (!noteFile) {
            new Notice('Could not find note file');
            return;
        }

        const content = await this.vault.read(noteFile);
        const taskBlock = this.findTaskBlock(content, task);
        
        if (!taskBlock) {
            new Notice('Could not find task in note content');
            return;
        }

        const processedContent = await this.processContent(taskBlock.content, noteFile);
        const newContent = content.replace(taskBlock.original, processedContent);

        await this.vault.modify(noteFile, newContent);
        new Notice(`Updated ${processedContent.images.length} images`);
    }

    private async processContent(content: string, noteFile: TFile): Promise<{ content: string; images: string[] }> {
        const imageRegex = /!\[(?<alt>[^\]]*)\]\((?<url>https?:\/\/[^\)]+)\)/gi;
        const images: string[] = [];
        let processedContent = content;

        let match: RegExpExecArray | null;
        while ((match = imageRegex.exec(content)) !== null) {
            const [fullMatch, alt, url] = match;
            try {
                const localPath = await this.downloadImage(url, noteFile);
                processedContent = processedContent.replace(fullMatch, `![${alt}](${localPath})`);
                images.push(localPath);
            } catch (e) {
                console.error('Image download failed:', e);
            }
        }

        return { content: processedContent, images };
    }

    private async downloadImage(url: string, noteFile: TFile): Promise<string> {
        // Get Obsidian's core attachment settings
        const attachmentPath = this.vault.getConfig('attachmentFolderPath') || 'Attachments';
        const noteDir = noteFile.parent?.path || '/';
        
        // Resolve absolute vs relative attachment path
        const isAbsolute = attachmentPath.startsWith('/');
        const destFolder = normalizePath(
            isAbsolute 
                ? attachmentPath 
                : `${noteDir}/${attachmentPath}`
        );

        // Create folder if needed
        if (!(await this.vault.adapter.exists(destFolder))) {
            await this.vault.createFolder(destFolder);
        }

        // Generate filename and full path
        const filename = this.createFilename(url);
        const destPath = `${destFolder}/${filename}`;

        // Download and save image
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const arrayBuffer = await response.arrayBuffer();
            await this.vault.createBinary(destPath, arrayBuffer);
            return this.vault.getResourcePath(destPath);
        } catch (e) {
            console.error('Failed to download image:', e);
            throw new Error(`Image download failed: ${url}`);
        }
    }

    private createFilename(url: string): string {
        const urlObj = new URL(url);
        const baseName = urlObj.pathname.split('/').pop() || 'image';
        const timestamp = Date.now();
        return `${baseName}-${timestamp}${this.getExtension(url)}`;
    }

    private getExtension(url: string): string {
        const match = url.match(/\.(jpe?g|png|gif|bmp|webp|svg)/i);
        return match ? match[0] : '.png';
    }

    private findTaskBlock(content: string, task: Task): { original: string; content: string } | null {
        const lines = content.split('\n');
        const taskLine = lines[task.line];
        
        if (!taskLine?.startsWith('+ ')) return null;

        const children: string[] = [];
        let currentLine = task.line + 1;

        while (currentLine < lines.length && lines[currentLine].startsWith('  ')) {
            children.push(lines[currentLine].replace(/^  \+/, '+'));
            currentLine++;
        }

        return {
            original: [taskLine, ...lines.slice(task.line + 1, currentLine)].join('\n'),
            content: [taskLine, ...children].join('\n')
        };
    }
}