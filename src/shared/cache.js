class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

class TTLCache extends LRUCache {
    constructor(maxSize, ttlMs = 300000) {
        super(maxSize);
        this.ttl = ttlMs;
    }

    set(key, value) {
        super.set(key, {
            value,
            expires: Date.now() + this.ttl
        });
    }

    get(key) {
        const item = super.get(key);
        if (!item) return null;
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
}

module.exports = {
    LRUCache,
    TTLCache
};
