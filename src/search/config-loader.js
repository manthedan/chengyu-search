/** @ts-check */

const path = require('path');

/**
 * @typedef {Record<string, unknown>} PlainObject
 * @typedef {(message: string, ...args: unknown[]) => void} LogErrorFn
 */

/**
 * @param {unknown} value
 * @returns {value is PlainObject}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} baseValue
 * @param {unknown} overrideValue
 * @returns {unknown}
 */
function deepMerge(baseValue, overrideValue) {
    if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
        return overrideValue;
    }

    const merged = { ...baseValue };
    Object.entries(overrideValue).forEach(([key, value]) => {
        if (isPlainObject(value) && isPlainObject(baseValue[key])) {
            merged[key] = deepMerge(baseValue[key], value);
        } else {
            merged[key] = value;
        }
    });
    return merged;
}

/**
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {LogErrorFn} [options.logError]
 * @returns {unknown}
 */
function loadSearchConfigOverride({ repoRoot = process.cwd(), logError = console.error } = {}) {
    try {
        if (process.env.SEARCH_CONFIG_OVERRIDE_JSON) {
            return JSON.parse(process.env.SEARCH_CONFIG_OVERRIDE_JSON);
        }

        if (process.env.SEARCH_CONFIG_OVERRIDE_FILE) {
            const overridePath = path.isAbsolute(process.env.SEARCH_CONFIG_OVERRIDE_FILE)
                ? process.env.SEARCH_CONFIG_OVERRIDE_FILE
                : path.join(repoRoot, process.env.SEARCH_CONFIG_OVERRIDE_FILE);
            delete require.cache[require.resolve(overridePath)];
            return require(overridePath);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('⚠️  Failed to load search config override:', message);
    }

    return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {PlainObject | null} [options.fallbackConfig]
 * @param {string} [options.repoRoot]
 * @param {LogErrorFn} [options.logError]
 * @returns {PlainObject}
 */
function loadFreshSearchConfig({
    configPath = path.join(__dirname, 'search-config.js'),
    fallbackConfig = null,
    repoRoot = process.cwd(),
    logError = console.error
} = {}) {
    /** @type {PlainObject} */
    let baseConfig;
    try {
        delete require.cache[require.resolve(configPath)];
        baseConfig = /** @type {PlainObject} */ (require(configPath));
    } catch (error) {
        baseConfig = fallbackConfig || {};
    }

    const overrideConfig = loadSearchConfigOverride({ repoRoot, logError });
    return isPlainObject(overrideConfig) ? /** @type {PlainObject} */ (deepMerge(baseConfig, overrideConfig)) : baseConfig;
}

/**
 * @param {object} [options]
 * @param {string} [options.hybridConfigPath]
 * @returns {PlainObject}
 */
function loadHybridOverrides({ hybridConfigPath = path.join(__dirname, 'hybrid-config.json') } = {}) {
    try {
        delete require.cache[require.resolve(hybridConfigPath)];
        return /** @type {PlainObject} */ (require(hybridConfigPath));
    } catch (error) {
        return {};
    }
}

module.exports = {
    isPlainObject,
    deepMerge,
    loadSearchConfigOverride,
    loadFreshSearchConfig,
    loadHybridOverrides
};
