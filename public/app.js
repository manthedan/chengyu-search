// Backend-powered Chengyu Search with automatic query routing and optional pagination.

const API_BASE_URL = window.location.origin;
const PAGE_SIZE = 10;

const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsSection = document.getElementById('results-section');
const resultsSummary = document.getElementById('results-summary');
const resultsContainer = document.getElementById('results-container');
const resultsActions = document.getElementById('results-actions');
const loadMoreBtn = document.getElementById('load-more-btn');
const errorMessage = document.getElementById('error-message');
const exampleChips = document.querySelectorAll('.example-chip');

let activeSearch = null;

function init() {
    searchBtn.addEventListener('click', handleSearch);
    loadMoreBtn.addEventListener('click', handleLoadMore);
    searchInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSearch();
        }
    });

    exampleChips.forEach(chip => {
        chip.addEventListener('click', () => {
            searchInput.value = chip.dataset.example;
            handleSearch();
        });
    });

    checkBackendHealth();
}

function createEmptySearchState() {
    return {
        query: '',
        mode: null,
        queryType: null,
        autoRouted: false,
        fallbackFrom: null,
        loadedCount: 0,
        hasMore: false,
        nextOffset: null
    };
}

async function checkBackendHealth() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/health`);
        const data = await response.json();
        console.log('Backend status:', data);

        if (!data.database) {
            showError('Backend search index is not ready yet.', 'error');
        }
    } catch (error) {
        console.error('Backend health check failed:', error);
        showError('Backend API not available. Please start the server.', 'error');
    }
}

async function performSearchRequest(query, offset = 0) {
    console.log(`Performing auto-routed search for: "${query}" (offset=${offset}, limit=${PAGE_SIZE})`);

    const response = await fetch(`${API_BASE_URL}/api/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query,
            offset,
            limit: PAGE_SIZE
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Search failed');
    }

    return response.json();
}

async function handleSearch() {
    const query = searchInput.value.trim();

    if (!query) {
        showError('Please enter a description');
        return;
    }

    activeSearch = createEmptySearchState();
    setLoading(true);
    setLoadMoreLoading(false);
    hideError();
    resultsSection.style.display = 'none';
    resultsSummary.style.display = 'none';
    resultsSummary.textContent = '';
    resultsContainer.innerHTML = '';
    resultsActions.style.display = 'none';

    try {
        const data = await performSearchRequest(query, 0);
        updateActiveSearch(data);
        renderResults(data, { append: false });
    } catch (error) {
        console.error('Search error:', error);
        showError(`Error: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

async function handleLoadMore() {
    if (!activeSearch || !activeSearch.query || !activeSearch.hasMore || activeSearch.nextOffset == null) {
        return;
    }

    setLoadMoreLoading(true);
    hideError();

    try {
        const data = await performSearchRequest(activeSearch.query, activeSearch.nextOffset);
        updateActiveSearch(data);
        renderResults(data, { append: true });
    } catch (error) {
        console.error('Load more error:', error);
        showError(`Error: ${error.message}`);
    } finally {
        setLoadMoreLoading(false);
    }
}

function updateActiveSearch(data) {
    activeSearch = {
        query: data.query,
        mode: data.mode,
        queryType: data.queryType,
        autoRouted: Boolean(data.autoRouted),
        fallbackFrom: data.fallbackFrom || null,
        loadedCount: (data.offset || 0) + (data.results || []).length,
        hasMore: Boolean(data.hasMore),
        nextOffset: data.nextOffset
    };
}

function formatModeLabel(mode) {
    return mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : 'Search';
}

function formatQueryTypeLabel(queryType) {
    return (queryType || 'unknown')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function updateResultsSummary() {
    if (!activeSearch) return;

    const modeLabel = formatModeLabel(activeSearch.mode);
    const routePrefix = activeSearch.autoRouted ? 'Auto-routed to ' : '';
    const fallbackSuffix = activeSearch.fallbackFrom ? ` · fallback from ${formatModeLabel(activeSearch.fallbackFrom)}` : '';
    const queryTypeSuffix = activeSearch.queryType ? ` · ${formatQueryTypeLabel(activeSearch.queryType)} query` : '';
    const moreSuffix = activeSearch.hasMore ? ' · more results available' : '';

    resultsSummary.textContent = `Showing ${activeSearch.loadedCount} results (${routePrefix}${modeLabel} search${queryTypeSuffix}${fallbackSuffix}${moreSuffix})`;
    resultsSummary.style.display = 'block';
}

function renderResults(data, { append = false } = {}) {
    const { results = [], query, offset = 0, hasMore = false } = data;

    const examplesSection = document.querySelector('.examples');
    if (examplesSection) {
        examplesSection.classList.add('hidden');
    }

    if (!append) {
        resultsContainer.innerHTML = '';
    }

    if (results.length === 0 && !append) {
        resultsContainer.innerHTML = `
            <div class="no-results">
                <p>No matching chengyu found for "${query}".</p>
                <p>Try using different keywords or describing the situation differently.</p>
            </div>
        `;
        resultsSummary.style.display = 'none';
        resultsActions.style.display = 'none';
        resultsSection.style.display = 'block';
        return;
    }

    results.forEach((result, index) => {
        const card = createResultCard(result, offset + index + 1);
        resultsContainer.appendChild(card);
    });

    updateResultsSummary();
    resultsActions.style.display = hasMore ? 'flex' : 'none';
    resultsSection.style.display = 'block';
}

function createResultCard(result, rank) {
    const card = document.createElement('div');
    card.className = 'result-card';

    card.innerHTML = `
        <div class="result-header">
            <div class="result-rank">#${rank}</div>
            <div class="result-main">
                <h3 class="result-chengyu">${result.chengyu}</h3>
                <p class="result-pinyin">${result.pinyin}</p>
            </div>
            <button class="copy-btn" data-chengyu="${result.chengyu}" title="Copy to clipboard">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </button>
        </div>

        <div class="result-content">
            <div class="result-section">
                <strong>Meaning:</strong>
                <p>${result.meaning}</p>
            </div>

            <div class="result-section">
                <strong>Literal translation:</strong>
                <p>${result.literal}</p>
            </div>

            <div class="result-section">
                <strong>Example:</strong>
                <p class="example">${result.example}</p>
            </div>

            <div class="result-tags">
                ${result.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                <span class="tag formality">${result.formality}</span>
            </div>
        </div>
    `;

    const copyBtn = card.querySelector('.copy-btn');
    const originalIcon = copyBtn.innerHTML;

    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(result.chengyu);
            copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            copyBtn.style.background = 'rgba(76, 175, 80, 0.3)';
            copyBtn.style.borderColor = 'rgba(76, 175, 80, 0.5)';
            setTimeout(() => {
                copyBtn.innerHTML = originalIcon;
                copyBtn.style.background = '';
                copyBtn.style.borderColor = '';
            }, 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
            copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            copyBtn.style.background = 'rgba(244, 67, 54, 0.3)';
            copyBtn.style.borderColor = 'rgba(244, 67, 54, 0.5)';
            setTimeout(() => {
                copyBtn.innerHTML = originalIcon;
                copyBtn.style.background = '';
                copyBtn.style.borderColor = '';
            }, 2000);
        }
    });

    return card;
}

function setLoading(loading) {
    searchBtn.disabled = loading;
    const btnText = searchBtn.querySelector('.btn-text');
    const btnLoading = searchBtn.querySelector('.btn-loading');

    if (loading) {
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline';
    } else {
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

function setLoadMoreLoading(loading) {
    loadMoreBtn.disabled = loading;
    loadMoreBtn.textContent = loading ? 'Loading...' : 'Load more results';
}

function showError(message, type = 'error') {
    errorMessage.textContent = message;
    errorMessage.className = `error-message ${type}`;
    errorMessage.style.display = 'block';
}

function hideError() {
    errorMessage.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', init);
