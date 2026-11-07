'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { LRUCache } = require('../shared/cache');
const { MODEL, queryText, queryKey, unitVector } = require('./hosted-recipe');
const RATE = 1075 / 1e6;
// Empty at every boot: restarts never grant fresh spending allowance. One
// active process earns 7,200/day; at most one earned neuron can cross midnight.
const RESTART_RATE = 7200 / 86400000;
const RESTART_BURST = 1;
function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function readCredentials(file) {
    // Data parsing only: never source this file or interpolate it into a shell.
    const values = {};
    try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const match = line.trim().match(/^(?:export\s+)?(CF_ACCOUNT_ID|CF_API_TOKEN)\s*=\s*(.*?)\s*$/);
            if (!match) continue;
            let value = match[2];
            if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) value = value.slice(1, -1);
            values[match[1]] = value;
        }
    } catch { throw Error('Cannot read runtime Cloudflare credentials; details omitted'); }
    if (!/^[a-f\d]{32}$/i.test(values.CF_ACCOUNT_ID || '') || !/^[A-Za-z\d_-]+$/.test(values.CF_API_TOKEN || '')) {
        throw Error('Invalid runtime Cloudflare credentials; details omitted');
    }
    return values;
}

class HostedEmbeddingClient {
    constructor({ env = process.env, fetchImpl = fetch, now = Date.now, monotonicNow = () => performance.now(), ledgerFile = env.HOSTED_NEURON_LEDGER || path.resolve('.cache/hosted-usage.json') } = {}) {
        this.fetch = fetchImpl; this.now = now; this.ledgerFile = ledgerFile;
        this.monotonicNow = monotonicNow; this.refilledAt = monotonicNow(); this.allowance = 0;
        this.account = env.CF_ACCOUNT_ID; this.token = env.CF_API_TOKEN;
        this.requested = env.HOSTED_EMBEDDINGS === 'on';
        this.enabled = this.requested && Boolean(this.account && this.token);
        this.waitMs = positive(env.HOSTED_EMBEDDING_WAIT_MS, 1500);
        this.timeoutMs = positive(env.HOSTED_EMBEDDING_TIMEOUT_MS, 12000);
        this.cap = Math.min(10000, positive(env.HOSTED_DAILY_NEURONS, 8000));
        this.maxInflight = Math.max(1, Math.min(32, Math.floor(positive(env.HOSTED_MAX_INFLIGHT, 4))));
        this.threshold = Math.floor(positive(env.HOSTED_BREAKER_FAILURES, 3));
        this.cooldownMs = positive(env.HOSTED_BREAKER_COOLDOWN_MS, 30000);
        this.cache = new LRUCache(Math.max(1, Math.min(8192, Math.floor(positive(env.HOSTED_EMBEDDING_CACHE_SIZE, 1024)))));
        this.inflight = new Map(); this.failures = 0; this.openUntil = 0; this.probing = false;
        this.continuations = new LRUCache(this.cache.maxSize);
        this.days = {}; this.ledgerOk = true; this.lastOutcome = this.enabled ? 'ready' : 'off';
        if (this.enabled && ledgerFile) {
            try {
                const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
                if (data.version !== 1 || !data.days || typeof data.days !== 'object' || Array.isArray(data.days)
                    || Object.entries(data.days).some(([d,n]) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(n) || n < 0)) throw Error();
                this.days = data.days;
            } catch (error) { if (error.code !== 'ENOENT') this.ledgerOk = false; }
        }
    }
    day() { return new Date(this.now()).toISOString().slice(0, 10); }
    refill() {
        const time = this.monotonicNow();
        this.allowance = Math.min(RESTART_BURST, this.allowance + Math.max(0, time - this.refilledAt) * RESTART_RATE);
        this.refilledAt = Math.max(time, this.refilledAt);
    }
    carryReservations() {
        const day = this.day();
        let changed = false;
        for (const job of this.inflight.values()) {
            if (!job.days.has(day)) {
                this.days[day] = (this.days[day] || 0) + job.reservation;
                job.days.add(day); changed = true;
            }
        }
        if (changed) this.persist();
    }
    persist() {
        if (!this.ledgerFile) return;
        try {
            fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
            const temp = this.ledgerFile + '.tmp';
            fs.writeFileSync(temp, JSON.stringify({ version: 1, days: this.days }) + '\n', { mode: 0o600 });
            fs.renameSync(temp, this.ledgerFile);
        } catch { this.ledgerOk = false; }
    }
    status() {
        this.carryReservations(); this.refill();
        return { status: this.enabled ? 'on' : 'off', cacheSize: this.cache.cache.size, inFlight: this.inflight.size,
            breaker: this.openUntil > this.now() ? 'open' : this.probing || this.openUntil ? 'half-open' : 'closed',
            neuronsUsedToday: this.days[this.day()] || 0, dailyNeuronLimit: this.cap, ledgerReady: this.ledgerOk,
            restartBudgetAvailable: Math.max(0, this.allowance), restartBudgetHourlyRate: 300,
            restartBudgetDailyRate: 7200, restartBudgetBurst: RESTART_BURST, lastOutcome: this.lastOutcome };
    }
    // Read-only continuation. Missing/expired IDs cannot start or retry work,
    // and an ID is bound to the exact normalized query/model/recipe identity.
    peek(query, requestId) {
        if (typeof requestId !== 'string') return { vector: null, reason: 'expired' };
        const job = this.continuations.get(requestId);
        if (!job || job.key !== queryKey(queryText(query)) || this.monotonicNow() > job.expiresAt) return { vector: null, reason: 'expired' };
        return job.result || { vector: null, reason: 'timeout', requestId: job.id };
    }
    async get(query, { waitMs = this.waitMs } = {}) {
        if (!this.enabled) return { vector: null, reason: 'off' };
        const text = queryText(query), key = queryKey(text);
        const cached = this.cache.get(key);
        if (cached) return { vector: cached, reason: 'cache' };
        // UTF-8 bytes conservatively bound byte-fallback tokenizer tokens. This
        // declines overlength queries to fallback, without silently clipping.
        if (Buffer.byteLength(text) + 1 > 512) return { vector: null, reason: 'input-limit' };
        let pending = this.inflight.get(key);
        if (!pending) {
            this.carryReservations(); this.refill();
            const blocked = this.blockedReason();
            if (blocked) { this.lastOutcome = blocked; return { vector: null, reason: blocked }; }
            const day = this.day(), reservation = (Buffer.byteLength(text) + 256) * RATE;
            if ((this.days[day] || 0) + reservation > this.cap) { this.lastOutcome = 'budget'; return { vector: null, reason: 'budget' }; }
            if (this.allowance < reservation) { this.lastOutcome = 'restart-budget'; return { vector: null, reason: 'restart-budget' }; }
            this.allowance -= reservation;
            this.days[day] = (this.days[day] || 0) + reservation;
            this.persist();
            if (!this.ledgerOk) return { vector: null, reason: 'ledger' };
            if (this.openUntil) this.probing = true;
            // The promise always resolves, including after a caller's wait has
            // expired. It owns the cache write and has a separate hard timeout.
            pending = { id: randomUUID(), key, reservation, days: new Set([day]), expiresAt: this.monotonicNow() + 60000, result: null };
            this.inflight.set(key, pending);
            this.continuations.set(pending.id, pending);
            pending.promise = this.request(text, key, pending).then(result => { pending.result = result; return result; })
                .finally(() => this.inflight.delete(key));
        }
        let timer;
        try {
            return await Promise.race([pending.promise, new Promise(resolve => {
                timer = setTimeout(() => resolve({ vector: null, reason: 'timeout', requestId: pending.id }), waitMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    blockedReason() {
        if (!this.ledgerOk) return 'ledger';
        if (this.openUntil > this.now() || this.probing) return 'breaker';
        if (this.inflight.size >= this.maxInflight) return 'capacity';
        return null;
    }
    async request(text, key, job) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let reason = 'transport';
        try {
            const res = await this.fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.account)}/ai/run/${MODEL}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify({ text: [text] }), signal: controller.signal, redirect: 'error'
            });
            if (!res.ok) { reason = 'http'; await res.body?.cancel(); throw Error(); }
            reason = 'invalid-response';
            const data = await res.json();
            const usage = data.result?.usage || data.usage;
            const tokens = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.total_tokens;
            const neurons = usage?.neurons ?? (Number.isFinite(tokens) && tokens >= 0 ? tokens * RATE : null);
            if (Number.isFinite(neurons) && neurons >= 0) {
                this.carryReservations();
                for (const day of job.days) this.days[day] = Math.max(0, (this.days[day] || 0) - job.reservation + neurons);
                this.refill();
                this.allowance = Math.min(RESTART_BURST, this.allowance + job.reservation - neurons);
                this.persist();
            }
            if (data.success === false || data.result?.data?.length !== 1) throw Error();
            const vector = unitVector(data.result.data[0]);
            this.cache.set(key, vector); this.failures = 0; this.openUntil = 0; this.lastOutcome = 'success';
            return { vector, reason: 'success' };
        } catch {
            // Provider errors can echo request headers, credentials or URLs.
            // Only our closed enum crosses this boundary, never the exception.
            if (controller.signal.aborted) reason = 'request-timeout';
            this.lastOutcome = reason;
            if (++this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
            return { vector: null, reason };
        } finally { this.carryReservations(); clearTimeout(timer); this.probing = false; }
    }
    async drain() { await Promise.all([...this.inflight.values()].map(job => job.promise)); }
}
module.exports = { HostedEmbeddingClient, readCredentials, RATE };
