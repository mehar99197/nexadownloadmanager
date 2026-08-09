'use strict';

const bcrypt = require('bcryptjs');
const { connectDB } = require('../config/db');
const { initSchema } = require('../config/schema');
const User = require('../models/User');
const Release = require('../models/Release');
const Review = require('../models/Review');

const RELEASE = {
  version: '0.1.0',
  windowsUrl: 'https://downloads.nexadownloadmanager.com/0.1.0/NexaDownloadManager-0.1.0-setup.exe',
  linuxUrl: 'https://downloads.nexadownloadmanager.com/0.1.0/nexadownloadmanager_0.1.0_amd64.deb',
  changelog: [
    'NexaDownloadManager 0.1.0', '',
    '- New: route Google Drive / GitHub downloads through the browser + yt-dlp',
    '- New: auto browser-login for sites that require authentication',
    '- Improved: cumulative downloaded size shown while a playlist downloads',
    '- Improved: resume capability is now always reported as Yes/No (never Unknown)',
    '- Fixed: HLS streams correctly reported as non-resumable',
    '- Packaging: fully self-contained offline installers (all libs bundled)',
  ].join('\n'),
  isLatest: true,
};

const REVIEWS = [
  { userName: 'Daniel R.', rating: 5, comment: 'Fastest downloader I have used. Segmented downloads saturate my connection.' },
  { userName: 'Aisha K.', rating: 5, comment: 'The browser extension just works — one click and it grabs the video.' },
  { userName: 'Marco P.', rating: 4, comment: 'Torrent + HTTP in one queue is brilliant. Would love more themes.' },
  { userName: 'Lena W.', rating: 5, comment: 'yt-dlp integration with quality picker is a game changer. Highly recommend.' },
];

async function main() {
  await connectDB();
  await initSchema();

  let latest = await Release.findLatest();
  if (!latest) {
    await Release.create(RELEASE);
  } else {
    await Release.unsetLatest();
    await Release.create(RELEASE);
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] release ${RELEASE.version} upserted (latest)`);

  let seedUser = await User.findByEmail('seed@nexadownloadmanager.com');
  if (!seedUser) {
    seedUser = await User.create({
      name: 'Seed User',
      email: 'seed@nexadownloadmanager.com',
      passwordHash: await bcrypt.hash('seed-user-no-login', 12),
      role: 'user',
      emailVerified: true,
    });
  }

  let added = 0;
  for (const r of REVIEWS) {
    const existing = await Review.findByUserId(seedUser.id);
    if (!existing) {
      await Review.create({ ...r, userId: seedUser.id, status: 'approved' });
      added += 1;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] reviews: ${added} added (${REVIEWS.length - added} already present)`);

  process.exit(0);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
