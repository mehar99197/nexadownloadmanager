#pragma once

#include <QUrl>

namespace nexa {

bool isPublicHttpUrl(const QUrl &url, bool resolveHost = true);

} // namespace nexa