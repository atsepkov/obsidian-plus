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
    - If you're provided additional context
        - Additional context represents parent bullets (previous conversation) prior to the question
        - Usually, you can ignore it
        - In some cases, the question doesn't make sense without it, so use it to clarify
        - Even if you can answer the question without it, verify if the context changes the question
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
            appendChildren: HttpConnector.convertLinesToChildren(children),
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
                finalPrompt += `<< LINK: ${attachment} >>\n`;
                finalPrompt += context.links[attachment] + '\n';
            }
        }
        console.log('Final prompt:', finalPrompt, context);
        window.context = context;

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
            appendChildren: HttpConnector.convertLinesToChildren(children),
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
            removeChildrenByBullet: '+*',
            appendChildren: HttpConnector.convertLinesToChildren(this.completedLines.filter(l => l.trim() !== '')),
            useBullet: '+'
        });
    }
}