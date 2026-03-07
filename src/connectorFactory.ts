import ObsidianPlus from './main'; // Adjust path if needed
import TagConnector from './connectors/tagConnector';

// Import connector types (adjust paths as needed)
import AiConnector from './connectors/aiConnector';
import DummyConnector from './connectors/dummyConnector';
import HttpConnector from './connectors/httpConnector';
import WebhookConnector from './connectors/webhookConnector';
import DSLConnector from './connectors/dslConnector';
// import WebConnector from './connectors/webConnector'; // Uncomment if used

// Import DSL utilities for detecting DSL config
import { hasDSLTriggers, parseDSLConfig } from './dsl';

// Define a type for the connector constructor
type ConnectorConstructor = new (tag: string, obsidianPlus: ObsidianPlus, config: any) => TagConnector;

// Define the structure of the connector map
interface ConnectorMap {
    [key: string]: ConnectorConstructor;
}

// Define ConnectorConfig interface (can be shared or refined later)
interface ConnectorConfig {
    connector?: string;
    webhookUrl?: string;
    url?: string;
    provider?: string;
    dslConfig?: any; // DSL configuration
    // Add other potential config properties
    [key: string]: any; // Allow arbitrary properties
}

// Map connector names to their constructor classes
const connectorMap: ConnectorMap = {
    'ai': AiConnector,
    'basic': TagConnector,
    'dummy': DummyConnector,
    'dsl': DSLConnector,
    'http': HttpConnector,
    'webhook': WebhookConnector,
    // 'web': WebConnector, // Uncomment if WebConnector is used
};

/**
 * Creates and returns an instance of a TagConnector based on the provided configuration.
 * @param tag - The tag associated with this connector.
 * @param config - The configuration object for the connector.
 * @param obsidianPlusInstance - The instance of the main ObsidianPlus plugin.
 * @returns An instantiated TagConnector or null if instantiation fails.
 */
export function createConnector(tag: string, config: ConnectorConfig, obsidianPlusInstance: ObsidianPlus): TagConnector | null {
    let connectorName = config.connector;

    // Check for DSL triggers first (highest priority)
    if (!connectorName && hasDSLTriggers(config)) {
        connectorName = 'dsl';
        
        // Parse DSL config and attach to config object
        const parseResult = parseDSLConfig(config, tag);
        if (parseResult.success && parseResult.config) {
            config.dslConfig = parseResult.config;
            console.log(`Detected DSL config for tag ${tag}:`, parseResult.config.triggers.map(t => t.type));
            if (parseResult.warnings?.length) {
                console.warn(`DSL parsing warnings for ${tag}:`, parseResult.warnings);
            }
        } else {
            console.error(`Failed to parse DSL config for tag ${tag}:`, parseResult.error);
            // Fall back to basic connector
            connectorName = 'basic';
        }
    }

    // Determine connector type if not explicitly set
    if (!connectorName) {
        if (config.webhookUrl) {
            connectorName = 'webhook';
        } else if (config.url) { // Assume HTTP if URL is present
            connectorName = 'http';
        } else if (config.provider) { // Assume AI if provider is present
             connectorName = 'ai';
        } else {
            connectorName = 'basic'; // Default
        }
    }

    const ConnectorClass = connectorMap[connectorName];

    if (ConnectorClass) {
        try {
            const connector = new ConnectorClass(tag, obsidianPlusInstance, config);
            console.log(`Built ${connectorName} connector for`, tag);
            return connector;
        } catch (error) {
             console.error(`Failed to instantiate ${connectorName} connector for tag ${tag}:`, error);
             return null; // Return null on instantiation failure
        }
    } else {
        console.warn(`Unknown connector type "${connectorName}" specified for tag ${tag}. Using basic connector.`);
        // Fallback to basic connector if type is unknown
        try {
            const connector = new TagConnector(tag, obsidianPlusInstance, config);
            return connector;
        } catch (error) {
             console.error(`Failed to instantiate basic fallback connector for tag ${tag}:`, error);
             return null; // Return null on fallback failure
        }
    }
}

/**
 * Check if a connector is a DSL connector
 */
export function isDSLConnector(connector: TagConnector | null): connector is DSLConnector {
    return connector instanceof DSLConnector;
}
