const express = require('express');
const cors = require('cors');

const { createSecurityHeadersMiddleware } = require('./middleware.js');
const { installHealthRoutes } = require('./health-routes.js');

function createApp({
    trustProxySetting,
    buildHstsHeader,
    isAllowedCorsOrigin,
    getJsonBodyLimit,
    publicDir,
    rateLimitMiddleware,
    healthRoutes,
    searchRoutes
}) {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', trustProxySetting);

    app.use(createSecurityHeadersMiddleware({ buildHstsHeader }));
    app.use(cors({
        origin(origin, callback) {
            callback(null, isAllowedCorsOrigin(origin));
        },
        methods: ['GET', 'HEAD', 'POST'],
        optionsSuccessStatus: 204
    }));
    app.use(express.json({ limit: getJsonBodyLimit() }));
    app.use(express.static(publicDir));

    if (rateLimitMiddleware) {
        app.use(rateLimitMiddleware);
    }

    installHealthRoutes(app, healthRoutes);

    app.post('/api/search', searchRoutes.auto);
    app.post('/api/search/keyword', searchRoutes.keyword);
    app.post('/api/search/semantic', searchRoutes.semantic);
    app.post('/api/search/hybrid', searchRoutes.hybrid);

    return app;
}

module.exports = {
    createApp
};
