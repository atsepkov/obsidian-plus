import HttpConnector from './httpConnector.js';

const systemPrompt = `
- instructions:
    - You're about to get a prompt in a bulleted format
        - The top-most bullet represents the question being asked
            - it may be worded as an instruction or a topic
            - if it's a topic, research it and summarize it
        - The child bullets nested under it represent additional context or clarifications
    - Follow this format:
        - Use bullets for your answer in the same format as these instructions
        - Each bullet should represent a separate idea/event/concept
        - Use 4 spaces for indentation
    - If you need to provide additional context for a given idea/bullet, use sub-bullets nested under it
    - Be concise
        - Aim for 1 sentence per bullet
        - If's ok to answer with a single bullet if the question asks for specific command or datapoint
        - If an item only has one sub-bullet, prefer "parent: sub-bullet" format instead
- prompt: `

/**
 * Converts an array of list item strings into structured entries with calculated indentation.
 * @param {string[]} lines - Array of list item strings.
 * @returns {Array<{indent: number, offset: number, text: string}>} - Processed entries.
 */
function convertLinesToChildren(lines) {
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

export default class AiConnector extends HttpConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('AiConnector initialized');
        this.gotResponse = false;
        this.responseBuffer = '';
        this.currentLine = 0;
        this.completedLines = [];
        this.originalLines = [];
    }

    // Override onTrigger to handle AI-specific logic
    async onTrigger(task) {
        console.log(`${this.tag} connector triggered`, task);

        // Extract the prompt from the task
        const prompt = task.text.replace(task.tags[0], '').trim();
        const context = this.obsidianPlus.getTaskChildren(task);
        console.log('Prompt:', prompt, context);

        // Prepare the AI request payload
        const payload = this.prepareAiPayload(prompt);

        // Get the endpoint URL for the configured AI provider
        const endpoint = this.getAiEndpoint();

        // Prepare authentication options
        const authOptions = this.prepareAuthOptions();

        // If streaming is enabled, add the `stream` option to the payload
        if (this.config.stream) {
            payload.stream = true;
            this.currentLine = 0;
            this.completedLines = [];
            this.originalLines = task.children;
        }

        console.log(`Sending AI request to ${endpoint} with payload:`, payload);

        // Send the request to the AI provider
        const response = await this.sendRequest(endpoint, payload, authOptions);

        // // Parse the response
        // const result = await response.json();
        // const aiResponse = this.parseAiResponse(result);

        // console.log('AI response:', aiResponse);
        // return aiResponse;
        // Handle streaming or non-streaming responses
        if (this.config.stream) {
            this.gotResponse = false;
            await this.handleStreamingResponse(response, async (content) => {
                console.log('Streaming content:', content);
                // Update the task with the streaming content
                await this.onStreamSuccess(task, content);
            });
            await this.finalizeStream(task); // Add this line
            return '';
        } else {
            const result = await response.json();
            const aiResponse = this.parseAiResponse(result);
            console.log('AI response:', aiResponse);
            return aiResponse;
        }
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
        const result = response.split('\n')
        for (const bullet of result) {
            children.push(bullet);
        }

        await this.obsidianPlus.updateTask(task, {
            append: status,
            appendChildren: convertLinesToChildren(children),
            useBullet: '+'
        });
    }

    // Override prepareAuthOptions to add provider-specific headers
    prepareAuthOptions() {
        const authOptions = super.prepareAuthOptions();

        const { provider, apiKey, token } = this.config.auth;

        // Add provider-specific headers
        if (provider === 'anthropic') {
            authOptions.headers['x-api-key'] = apiKey || token;
        }

        return authOptions;
    }

    // Override sendRequest to add AI-specific error handling or logging
    async sendRequest(url, data, options = {}) {
        try {
            // Call the original sendRequest method from HttpConnector
            const response = await super.sendRequest(url, data, options);

            // Optionally add AI-specific logging or error handling
            console.log('AI request sent successfully');
            return response;
        } catch (error) {
            console.error('AI request failed:', error);
            throw error;
        }
    }

    prepareAiPayload(prompt) {
        const { provider } = this.config.auth;

        switch (provider) {
            case 'deepseek':
            case 'openai':
                return {
                    model: this.config.model,
                    messages: [{ role: 'user', content: systemPrompt + prompt }],
                    temperature: this.config.temperature || 0.7,
                };
            case 'anthropic':
                return {
                    prompt: `\n\nHuman: ${prompt}\n\nAssistant:`,
                    model: 'claude-3.5-sonnet',
                    max_tokens_to_sample: this.config.max_tokens || 1000,
                };
            default:
                throw new Error(`Unsupported AI provider: ${provider}`);
        }
    }

    getAiEndpoint() {
        const { provider } = this.config.auth;

        switch (provider) {
            case 'deepseek':
                return 'https://api.deepseek.com/chat/completions';
            case 'openai':
                return 'https://api.openai.com/v1/chat/completions';
            case 'anthropic':
                return 'https://api.anthropic.com/v1/complete';
            default:
                throw new Error(`Unsupported AI provider: ${provider}`);
        }
    }

    parseAiResponse(response) {
        const { provider } = this.config.auth;

        switch (provider) {
            case 'deepseek':
            case 'openai':
                return response.choices[0].message.content;
            case 'anthropic':
                return response.completion;
            default:
                throw new Error(`Unsupported AI provider: ${provider}`);
        }
    }

    // HANDLE STREAMING RESPONSES

    async onStreamSuccess(task, response) {
        console.log(`${this.tag} connector stream`, response);
        let status;
        if (!this.gotResponse) {
            status = '✓';
            if (this.config.timestamps) {
                status += ` ${new Date().toLocaleString()}`;
            }
            this.gotResponse = true;
        }

        const { provider } = this.config.auth;
        let textContent = '';

        // Extract content based on provider
        switch(provider) {
            case 'deepseek':
            case 'openai':
                textContent = response.choices[0]?.delta?.content || '';
                break;
            case 'anthropic':
                textContent = response.completion || '';
                break;
            default:
                throw new Error(`Unsupported provider: ${provider}`);
        }

        // Add to buffer
        this.responseBuffer += textContent;

        // Process buffer for line breaks
        let newLines = [];
        let lastNewline = this.responseBuffer.lastIndexOf('\n');

        if (lastNewline !== -1) {
            const complete = this.responseBuffer.substring(0, lastNewline + 1);
            this.responseBuffer = this.responseBuffer.substring(lastNewline + 1);
            newLines = complete.split('\n').filter(l => l && l.trim());
            this.completedLines.push(...newLines);
        }

        // Prepare children array
        const children = [...this.completedLines];
        if (this.responseBuffer && this.responseBuffer.trim()) {
            children.push(this.responseBuffer);
        }

        console.log('Children:', children, this.completedLines, this.responseBuffer);
        await this.obsidianPlus.updateTask(task, {
            append: status,
            replaceChildren: convertLinesToChildren(children),
            useBullet: '+'
        });
    }

    // Modified handleStreamingResponse (your existing method)
    async handleStreamingResponse(response, streamingCallback) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            
            // Process complete SSE events
            const events = sseBuffer.split('\n');
            sseBuffer = events.pop();

            for (const event of events) {
                const trimmed = event.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;

                // Extract JSON payload
                const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
                
                try {
                    const parsed = JSON.parse(jsonStr);
                    await streamingCallback(parsed); // Keep your existing flow
                } catch (error) {
                    console.error('Error parsing chunk:', error, jsonStr);
                }
            }
        }

        // Process final chunk
        if (sseBuffer.trim()) {
            try {
                const parsed = JSON.parse(sseBuffer);
                await streamingCallback(parsed);
            } catch (error) {
                console.error('Error parsing final chunk:', error);
            }
        }
    }

    // Handle final cleanup
    async finalizeStream(task) {
        // Process any remaining buffer content
        if (this.responseBuffer.trim() !== '') {
            this.completedLines.push(this.responseBuffer);
            this.responseBuffer = '';
        }

        // Final update with all completed lines
        await this.obsidianPlus.updateTask(task, {
            replaceChildren: convertLinesToChildren(this.completedLines.filter(l => l.trim() !== '')),
            useBullet: '+'
        });
    }
}