/** @ts-check */

/**
 * @template K, V
 */
class LRUCache {
    /**
     * @param {number} maxSize
     */
    constructor(maxSize) {
        this.maxSize = maxSize;
        /** @type {Map<K, V>} */
        this.cache = new Map();
    }

    /**
     * @param {K} key
     * @returns {V | null}
     */
    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        if (value === undefined) return null;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    /**
     * @param {K} key
     * @param {V} value
     */
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

/**
 * @template V
 * @typedef {{ value: V, expires: number }} TTLCacheEntry
 */

/**
 * @template K, V
 */
class TTLCache {
    /**
     * @param {number} maxSize
     * @param {number} [ttlMs]
     */
    constructor(maxSize, ttlMs = 300000) {
        this.maxSize = maxSize;
        this.ttl = ttlMs;
        /** @type {Map<K, TTLCacheEntry<V>>} */
        this.cache = new Map();
    }

    /**
     * @param {K} key
     * @param {V} value
     */
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, {
            value,
            expires: Date.now() + this.ttl
        });
    }

    /**
     * @param {K} key
     * @returns {V | null}
     */
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        this.cache.delete(key);
        if (Date.now() > item.expires) {
            return null;
        }
        this.cache.set(key, item);
        return item.value;
    }

    clear() {
        this.cache.clear();
    }
}

module.exports = {
    LRUCache,
    TTLCache
};
