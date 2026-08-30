'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const config = require('./config/env');
const { ok } = require('./utils/respond');
const asyncHandler = require('./utils/asyncHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const User = require('./models/User');
const Release = require('./models/Release');
const { publicStats } = require('./utils/stats');

const app = express();

app.set('trust proxy', config.TRUST_PROXY || false);

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
app.use(cookieParser());

if (!config.isProd) app.use(morgan('dev'));

app.use('/api/webhooks/stripe', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => ok(res, { status: 'up' }));

app.get(
  '/api/stats',
  asyncHandler(async (req, res) => {
    // Real numbers only: registered users + SUM(releases.download_count),
    // which the counting redirect (GET /api/releases/download/:os) increments.
    const [users, downloads] = await Promise.all([User.count(), Release.sumDownloadCount()]);
    // Below the configured floor a figure is omitted, never rounded up.
    return ok(res, publicStats({ users, downloads }, {
      minUsers: config.STATS_MIN_USERS, minDownloads: config.STATS_MIN_DOWNLOADS,
    }));
  })
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/license', require('./routes/license'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/releases', require('./routes/releases'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/root', require('./routes/root'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/team', require('./routes/team'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
