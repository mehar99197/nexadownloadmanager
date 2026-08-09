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
    const users = await User.count();
    return ok(res, { users, downloads: 10000 + users * 7 });
  })
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/license', require('./routes/license'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/releases', require('./routes/releases'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/webhooks', require('./routes/webhooks'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
