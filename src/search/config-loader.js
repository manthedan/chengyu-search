const path = require('path');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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
        logError('⚠️  Failed to load search config override:', error.message);
    }

    return null;
}

function loadFreshSearchConfig({
    configPath = path.join(__dirname, 'search-config.js'),
    fallbackConfig = null,
    repoRoot = process.cwd(),
    logError = console.error
} = {}) {
    let baseConfig;
    try {
        delete require.cache[require.resolve(configPath)];
        baseConfig = require(configPath);
    } catch (error) {
        baseConfig = fallbackConfig || {};
    }

    const overrideConfig = loadSearchConfigOverride({ repoRoot, logError });
    return overrideConfig ? deepMerge(baseConfig, overrideConfig) : baseConfig;
}

function loadHybridOverrides({ hybridConfigPath = path.join(__dirname, 'hybrid-config.json') } = {}) {
    try {
        delete require.cache[require.resolve(hybridConfigPath)];
        return require(hybridConfigPath);
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
