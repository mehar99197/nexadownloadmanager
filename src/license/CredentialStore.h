#pragma once

#include <QString>

namespace nexa::credentialstore {

QString readLicenseKey();
bool writeLicenseKey(const QString &key);
bool removeLicenseKey();

} // namespace nexa::credentialstore