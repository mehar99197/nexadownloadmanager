#pragma once

#include <QString>

namespace nexa::portable {

// "Portable mode": Nexa keeps its settings, database, logs and downloads inside
// its own folder instead of the user's profile, so the whole app can live on a
// USB stick and leave no trace on the host machine.
//
// It is enabled by placing a file named `portable.txt` (contents ignored) next
// to the executable, which the Windows portable zip ships with. Detection runs
// once, before any QSettings or database access.
bool isPortable();

// Root of the portable data folder (`<app dir>/NexaData`), created on demand.
// Empty when not in portable mode.
QString dataDir();

// Where settings/database/logs should live: the portable folder when portable,
// otherwise the platform's per-user application-data directory.
QString appDataDir();

// Call ONCE at startup, before QSettings is used, so QSettings resolves to the
// portable .ini instead of the registry / ~/.config.
void initialise();

} // namespace nexa::portable
