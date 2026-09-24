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
const { originGuard } = require('./middleware/originGuard');
const { noStore } = require('./middleware/noStore');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const User = require('./models/User');
const Release = require('./models/Release');
const { publicStats } = require('./utils/stats');

const app = express();

app.set('trust proxy', config.TRUST_PROXY || false);
// Query strings parse to flat strings only. The default ('extended', via qs)
// turns `?q[]=x` into an array and `?a[b]=1` into an object, so a handler that
// expects `req.query.q` to be a string can be handed something else — the
// zod schemas reject that, but the routes that read req.query directly should
// never see it in the first place. Nothing here needs nested query syntax.
// Set before the first app.use(): Express builds its router, with the parser
// it will use, the moment anything is mounted.
app.set('query parser', 'simple');

// Nothing served from this API is ever meant to sit in a frame: DENY, and the
// CSP equivalent. The site's HTML gets the same from deploy/hostinger/.htaccess.
app.use(helmet({
  frameguard: { action: 'deny' },
  contentSecurityPolicy: {
    directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'frame-ancestors': ["'none'"] },
  },
}));
// The export caps are reported in headers (routes/admin.js#reportExport); a
// panel served from another allowed origin could not read them otherwise.
app.use(cors({
  origin: config.CORS_ORIGINS,
  credentials: true,
  exposedHeaders: ['X-Export-Total', 'X-Export-Limit', 'X-Export-Truncated'],
}));
app.use(cookieParser());

// Request logging.
//
// Production used to have NONE of this — the line was `if (!config.isProd)` and
// nothing else — so once the box went to NODE_ENV=production the only thing
// reaching api.log was errors and boot lines. That is the wrong way round: an
// incident is exactly when you want to know which requests arrived, from where.
//
// Two deliberate differences from the dev format:
//
//  - the PATH is logged, never the query string. No endpoint here takes a
//    credential in the query today, but an access log is copied into tickets
//    and pasted into chats, and a format that cannot leak a token even if one
//    is added later is worth the lost `?placement=`.
//  - the keepalive's /api/health probe runs every minute forever. Logging it
//    would make it most of the file, so a successful health check is skipped
//    while a failing one still shows up.
//
// run-api.sh rotates api.log at 50MB (copytruncate, safe against the live
// writer), so this cannot grow without bound on shared hosting.
morgan.token('path', (req) => String(req.originalUrl || req.url).split('?')[0]);
if (!config.isProd) {
  app.use(morgan('dev'));
} else {
  app.use(morgan(':remote-addr :method :path :status :res[content-length] - :response-time ms', {
    skip: (req, res) => req.path === '/api/health' && res.statusCode < 400,
  }));
}

app.use('/api/webhooks/stripe', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));
// The API speaks JSON; a form-encoded body is only ever accepted at all so a
// stray client gets a validation error instead of a parser one. Flat and small.
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use('/api', apiLimiter);
// Second layer under SameSite=Lax for state-changing requests — see the
// middleware for why a MISSING Origin is deliberately allowed through.
app.use('/api', originGuard);
// Uncacheable by default. A route that is genuinely public overrides this with
// its own Cache-Control — see middleware/noStore.js for why the default flipped.
app.use('/api', noStore);

app.get('/api/health', (req, res) => ok(res, { status: 'up', billing: config.stripeMode }));

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
app.use('/api/device', require('./routes/device'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/releases', require('./routes/releases'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/root', require('./routes/root'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/faq', require('./routes/faq'));
app.use('/api/team', require('./routes/team'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
