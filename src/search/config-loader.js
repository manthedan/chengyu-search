/** @ts-check */

const path = require('path');
const fs = require('fs');

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

// One entry per config role, including when an operator changes override paths.
// Deleting require.cache alone leaves modules alive in their parents' children.
/** @type {Map<string, {filename: string, source: string, value: unknown}>} */
const configFiles = new Map();
/** @type {{source: string, value: unknown} | null} */
let inlineOverride = null;

/** @param {string} filename */
function evictConfigFile(filename) {
    for (const parent of Object.values(require.cache)) {
        if (parent) {
            parent.children = parent.children.filter(child => child.filename !== filename);
            // A dependency's reverse parent link can retain its first loader,
            // even after that loader has left require.cache and children.
            if (parent.parent?.filename === filename) parent.parent = null;
        }
    }
    delete require.cache[filename];
}

/** @param {string} role */
function clearConfigRole(role) {
    const previous = configFiles.get(role);
    configFiles.delete(role);
    if (previous && ![...configFiles.values()].some(entry => entry.filename === previous.filename)) {
        evictConfigFile(previous.filename);
    }
}

/** @param {string} role @param {string} filename @returns {unknown} */
function loadConfigFile(role, filename) {
    try {
        const resolved = require.resolve(filename);
        // Compare contents as well as paths: atomic replacements and edits with
        // unchanged timestamps must still reload. Config files are only a few KB.
        const source = fs.readFileSync(resolved, 'utf8');
        const cached = configFiles.get(role);
        if (cached?.filename === resolved && cached.source === source) return cached.value;
        clearConfigRole(role);
        evictConfigFile(resolved);
        let value;
        try { value = require(resolved); }
        catch (error) {
            evictConfigFile(resolved);
            throw error;
        } finally {
            const owner = require.cache[__filename];
            if (owner) owner.children = owner.children.filter(child => child.filename !== resolved);
        }
        configFiles.set(role, { filename: resolved, source, value });
        return value;
    } catch (error) {
        clearConfigRole(role);
        throw error;
    }
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
            clearConfigRole('override');
            const source = process.env.SEARCH_CONFIG_OVERRIDE_JSON;
            if (inlineOverride?.source !== source) inlineOverride = { source, value: JSON.parse(source) };
            return inlineOverride.value;
        }

        inlineOverride = null;
        if (process.env.SEARCH_CONFIG_OVERRIDE_FILE) {
            const overridePath = path.isAbsolute(process.env.SEARCH_CONFIG_OVERRIDE_FILE)
                ? process.env.SEARCH_CONFIG_OVERRIDE_FILE
                : path.join(repoRoot, process.env.SEARCH_CONFIG_OVERRIDE_FILE);
            return loadConfigFile('override', overridePath);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('⚠️  Failed to load search config override:', message);
    }

    clearConfigRole('override');
    inlineOverride = null;
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
        baseConfig = /** @type {PlainObject} */ (loadConfigFile('base', configPath));
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
        return /** @type {PlainObject} */ (loadConfigFile('hybrid', hybridConfigPath));
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
