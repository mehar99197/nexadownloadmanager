#pragma once

#include <QString>

namespace nexa::credentialstore {

// The licence key, typed by hand for manual activation.
QString readLicenseKey();
bool writeLicenseKey(const QString &key);
bool removeLicenseKey();

// The device token handed out when this machine is signed in to an account
// (routes/device.js on the server). It is bound to this machine's fingerprint
// and is useless anywhere else, but it speaks for the account here, so it
// lives in the OS credential store beside the key rather than in QSettings.
QString readAccountToken();
bool writeAccountToken(const QString &token);
bool removeAccountToken();

} // namespace nexa::credentialstore
