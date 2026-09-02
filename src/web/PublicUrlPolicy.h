#pragma once

#include <QUrl>

namespace nexa {

bool isPublicHttpUrl(const QUrl &url, bool resolveHost = true);

// Resolving a host blocks the caller, so the verdict is cached per host for a
// short window (see PublicUrlPolicy.cpp for why that is safe). These two exist
// for tests, which need to start from a known state and to assert how many real
// lookups actually happened.
void resetHostVerdictCache();
int  hostVerdictLookupCount();

} // namespace nexa
