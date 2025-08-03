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
        - Response format is Markdown, if you need to render images, use ![name](url)
    - If you need to provide additional context for a given idea/bullet, use sub-bullets nested under it
    - Be concise
        - Aim for 1 sentence per bullet
        - If's ok to answer with a single bullet if the question asks for specific command or datapoint
        - If an item only has one sub-bullet, prefer "parent: sub-bullet" format instead
        - If the root bullet restates the question, omit it in the answer
    - If you're provided additional context
        - Additional context represents parent bullets (previous conversation) prior to the question
        - Usually, you can ignore it
        - In some cases, the question doesn't make sense without it, so use it to clarify
        - Even if you can answer the question without it, verify if the context changes the question
        - Any linked documents are in Markdown format:
            - When images are referenced, look for elements with ![name](url) format
            - If the linked document is from a website, assume earlier images on the page are more significant
- prompt: `


export default class AiConnector extends HttpConnector {
    constructor(tag, obsidianPlus, config) {
        super(tag, obsidianPlus, config);
        console.log('AiConnector initialized');
        this.gotResponse = false;
        this.responseBuffer = '';
        this.currentLine = 0;
        this.completedLines = [];
        this.originalLines = [];

        // status for long-running requests
        this.lastActivityTime = Date.now();
        this.queuedTimeout = null;
        this.loadingStates = new Map(); // Track loading states per task
    }

    // Override onTrigger to handle AI-specific logic
    async onTrigger(task) {
        console.log(`${this.tag} connector triggered`, task);

        // Extract the prompt from the task
        const prompt = task.text.replace(task.tags[0], '').trim();
        const context = await this.obsidianPlus.getTaskContext(task);
        console.log('Prompt:', prompt, context);

        // Prepare the AI request payload
        const payload = this.prepareAiPayload(prompt, context);

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
        await this.obsidianPlus.updateTask(task, {
            removeChildrenByBullet: '+*',
            appendChildren: await this.convertLinesToChildren(['⌛ processing...']),
            useBullet: '+'
        });

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
            await this.handleStreamingResponse(task, response, async (content) => {
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
        const result = (response || '').split('\n')
        for (const bullet of result) {
            if (!bullet.trim()) continue;
            children.push(bullet);
        }

        await this.obsidianPlus.updateTask(task, {
            append: status,
            appendChildren: await this.convertLinesToChildren(children),
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

    // This is basically a clone of super.sendRequest that uses native fetch to allow streaming.
    // Streaming doesn't work with requestUrl, which is used in httpConnector to bypass CORS.
    async sendRequest(url, data, options = {}) {
        const method = (this.config.method ?? "GET").toUpperCase();
    
        const headers = {
            "Content-Type": "application/json",
            ...(this.config.headers ?? {}),
            ...options.headers
        };
    
        const fetchOptions = {
            method,
            headers,
            body: method === "GET" ? undefined : JSON.stringify(data),
        };
    
        try {
            const response = await fetch(url, fetchOptions);
    
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
    
            // STREAM MODE
            if (data.stream) {
                if (!response.body) throw new Error("No body in response for stream");
    
                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
    
                // Use this to accumulate streamed chunks
                const streamParser = options.onChunk || console.log;
    
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split("\n").filter(line => line.startsWith("data: "));
    
                    for (const line of lines) {
                        const payload = line.slice(6).trim(); // strip "data: "
    
                        if (payload === "[DONE]") return;
    
                        try {
                            const parsed = JSON.parse(payload);
                            streamParser(parsed);
                        } catch (err) {
                            console.warn("Malformed chunk ignored:", payload);
                        }
                    }
                }
    
                return; // stream is already handled
            }
    
            // NON-STREAM MODE
            const json = await response.json();
            return {
                status: response.status,
                json,
                headers: Object.fromEntries(response.headers.entries())
            };
        } catch (error) {
            console.error(`Failed to send request to ${url}:`, error);
            throw error;
        }
    }

    prepareAiPayload(prompt, context) {
        const { provider } = this.config.auth;

        let finalPrompt = systemPrompt + prompt;
        for (const child of context.children) {
            if (child.bullet === '-' && child.text.trim()) { // only take user input
                finalPrompt += `\n${' '.repeat(child.indent) + child.bullet} ${child.text}`;
            }
        }
        if (context.parents.length > 0) {
            finalPrompt += `\nAdditional context that may or may not be relevant:\n`;
            // Add in reverse from parent to grandparent
            for (let i = context.parents.length - 1; i >= 0; i--) {
                finalPrompt += 'grand-'.repeat(context.parents.length - i - 1) + 'parent: ';
                finalPrompt += context.parents[i].text + '\n';
            }
        }
        if (Object.keys(context.links).length > 0) {
            finalPrompt += `\n\nContents of Mentioned Links/Documents:\n`;
            for (const attachment in context.links) {
                if (!context.links[attachment]) {
                    throw new Error(`Couldn't fetch contents of ${attachment}`)
                } else if (context.links[attachment].error) {
                    throw new Error(context.links[attachment].error)
                }
                finalPrompt += `<< LINK: ${attachment} >>\n`;
                finalPrompt += context.links[attachment] + '\n';
            }
        }
        console.log('Final prompt:', finalPrompt, context);

        switch (provider) {
            case 'deepseek':
            case 'openai':
                return {
                    model: this.config.model,
                    messages: [{ role: 'user', content: finalPrompt }],
                    temperature: this.config.temperature || 0.7,
                };
            case 'anthropic':
                return {
                    prompt: `\n\nHuman: ${finalPrompt}\n\nAssistant:`,
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
        this.loadingStates.delete(task.id);
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

        await this.obsidianPlus.updateTask(task, {
            append: status,
            removeChildrenByBullet: '+*',
            appendChildren: await this.convertLinesToChildren(children),
            useBullet: '+'
        });
    }

    // Modified handleStreamingResponse (your existing method)
    async handleStreamingResponse(task, response, streamingCallback) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        // Add timeout check every 2 seconds
        const checkQueueStatus = async () => {
            const elapsed = Date.now() - this.lastActivityTime;
            if (elapsed > 180_000) {
                await this.handleTimeout(task);
            } else if (elapsed > 5000) { // 5 seconds without activity
                await this.showQueueWarning(task);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            this.lastActivityTime = Date.now();
            if (this.queuedTimeout) clearTimeout(this.queuedTimeout);
            this.queuedTimeout = setTimeout(checkQueueStatus, 5000);

            sseBuffer += decoder.decode(value, { stream: true });
            
            // Process complete SSE events
            const events = sseBuffer.split('\n');
            sseBuffer = events.pop();

            for (const event of events) {
                const trimmed = event.trim();
                if (!trimmed) continue;
                if (trimmed === 'data: [DONE]') {
                    console.log('Stream completed');
                    continue;
                }

                if (trimmed.startsWith(":")) {
                    this.handleKeepAlive(task);
                    continue;
                }

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

        // Clear timeout when stream completes
        if (this.queuedTimeout) clearTimeout(this.queuedTimeout);

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
        console.log('Finalizing stream');
        // Process any remaining buffer content
        if (this.responseBuffer.trim() !== '') {
            this.completedLines.push(this.responseBuffer);
            this.responseBuffer = '';
        }
        if (this.completedLines.length === 0) {
            console.log('No content received');
            // No content received
            const error = 'No content received, server could be busy...';
            await this.obsidianPlus.changeTaskStatus(task, 'error', error);
            await this.obsidianPlus.updateTask(task, {
                removeChildrenByBullet: '+*',
                appendChildren: await this.convertLinesToChildren([error]),
                useBullet: '*'
            });
        } else {
            // Final update with all completed lines
            await this.obsidianPlus.updateTask(task, {
                removeChildrenByBullet: '+*',
                appendChildren: await this.convertLinesToChildren(this.completedLines.filter(l => l.trim() !== ''), { downloadImages: this.config.downloadImages }),
                useBullet: '+'
            });
        }
    }

    // keep-alive handlers
    async handleKeepAlive(task) {
        this.loadingStates.set(task.id, true);
        await this.showQueueStatus(task);
    }
    
    async showQueueStatus(task) {
        const status = this.loadingStates.has(task.id) ? '…' : '✓';
        await this.obsidianPlus.updateTask(task, {
            removeChildrenByBullet: '+*',
            appendChildren: await this.convertLinesToChildren([status]),
            useBullet: '+'
        });
    }
    
    async showQueueWarning(task) {
        await this.obsidianPlus.updateTask(task, {
            removeChildrenByBullet: '+*',
            appendChildren: await this.convertLinesToChildren(['⌛ (processing slow, still working...)']),
            useBullet: '+'
        });
    }

    async handleTimeout(task) {
        await this.obsidianPlus.updateTask(task, {
            removeChildrenByBullet: '+*',
            appendChildren: await this.convertLinesToChildren(['Processing timeout, server could be busy...']),
            useBullet: '*'
        });
    }
}