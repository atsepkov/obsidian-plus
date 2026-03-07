/**
 * Type declarations for JavaScript connectors
 */

declare module '../connectors/tagConnector' {
    export interface ConnectorConfig {
        connector?: string;
        webhookUrl?: string;
        url?: string;
        provider?: string;
        errorFormat?: string;
        timestamps?: boolean;
        retry?: string | number;
        clearErrorsOnSuccess?: boolean;
        clearErrorsOnReset?: boolean;
        [key: string]: any;
    }

    export default class TagConnector {
        tag: string;
        obsidianPlus: any;
        config: ConnectorConfig;

        constructor(tag: string, obsidianPlus: any, config?: any);

        onTrigger(task: any): Promise<any>;
        onSuccess(task: any, response: any): Promise<any>;
        onError(task: any, error: any): Promise<any>;
        onReset(task: any): Promise<any>;
        onData(data: any): Promise<any>;
        defaultFilter(task: any): boolean;
        defaultFormat(task: any): any;
        convertLinesToChildren(lines: string[], options?: any): Promise<any[]>;
        downloadImages(lines: string[]): Promise<string[]>;
        downloadImage(url: string): Promise<string>;
        createFilename(url: string): string;
        getExtension(url: string): string;
        sendRequest?(url: string, body: any, options?: any): Promise<any>;
        prepareAuthOptions?(): any;
    }
}

declare module '../connectors/httpConnector' {
    import TagConnector from '../connectors/tagConnector';

    export default class HttpConnector extends TagConnector {
        constructor(tag: string, obsidianPlus: any, config?: any);
        onTrigger(task: any): Promise<any>;
        sendRequest(url: string, body: any, options?: any): Promise<any>;
        prepareAuthOptions(): any;
    }
}

declare module '../connectors/aiConnector' {
    import HttpConnector from '../connectors/httpConnector';

    export default class AiConnector extends HttpConnector {
        constructor(tag: string, obsidianPlus: any, config?: any);
    }
}

declare module '../connectors/webhookConnector' {
    import TagConnector from '../connectors/tagConnector';

    export default class WebhookConnector extends TagConnector {
        constructor(tag: string, obsidianPlus: any, config?: any);
        onTrigger(task: any): Promise<any>;
    }
}

declare module '../connectors/dummyConnector' {
    import TagConnector from '../connectors/tagConnector';

    export default class DummyConnector extends TagConnector {
        constructor(tag: string, obsidianPlus: any, config?: any);
        onTrigger(task: any): Promise<any>;
    }
}

declare module '../connectors/webConnector' {
    import TagConnector from '../connectors/tagConnector';

    export default class WebConnector extends TagConnector {
        constructor(tag: string, obsidianPlus: any, config?: any);
    }
}
