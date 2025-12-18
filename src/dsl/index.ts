/**
 * DSL Module Index
 * 
 * Exports all DSL-related types, functions, and classes.
 */

// Types
export type {
    PatternToken,
    PatternTokenType,
    PatternExtractionResult,
    ActionNode,
    ActionType,
    BaseActionNode,
    ReadActionNode,
    FetchActionNode,
    TransformActionNode,
    TransformChild,
    BuildActionNode,
    QueryActionNode,
    SetActionNode,
    MatchActionNode,
    IfActionNode,
    ElseActionNode,
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
    AuthConfig,
    TriggerType,
    DSLTrigger,
    DSLConfig,
    DSLContext,
    CursorPosition,
    CreateContextOptions,
    DSLExecutionResult,
    RawConfigItem,
    ParseResult
} from './types';

// Pattern Matcher
export {
    parsePattern,
    extractValues,
    interpolate,
    hasPatternTokens,
    getReferencedVariables,
    createTagPattern,
    evaluateCondition,
    cleanTemplate
} from './patternMatcher';

// Parser
export {
    hasDSLTriggers,
    parseDSLConfig,
    convertConfigChildren,
    parseTriggerFromConfigLoader
} from './parser';

// Actions
export {
    actionHandlers,
    getActionHandler,
    readAction,
    fetchAction,
    transformAction,
    buildAction,
    queryAction,
    setAction,
    matchAction,
    ifAction,
    logAction,
    notifyAction,
    extractAction,
    foreachAction,
    returnAction,
    appendAction,
    taskAction,
    validateAction,
    delayAction,
    filterAction,
    mapAction,
    dateAction
} from './actions';
export type { ActionHandler } from './actions';

// Executor
export {
    createContext,
    executeTrigger,
    executeTriggerByType,
    DSLEngine,
    createDSLEngine
} from './executor';

