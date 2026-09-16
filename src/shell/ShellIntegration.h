#pragma once

#include <QString>
#include <QVector>

namespace nexa {

// Windows shell integration: an "Open with Nexa" entry on the file types Nexa
// understands, and a "New download with Nexa" item on a folder's background.
//
// Everything is written under the CURRENT USER's class registrations. That is a
// deliberate choice rather than a limitation: it needs no administrator, it
// cannot affect another account on the machine, and it is removable by the same
// code that wrote it. Nothing here STEALS a file association either --
// .torrent and friends are registered through OpenWithProgids, which adds Nexa
// to the "Open with" list and leaves whatever the person already uses as the
// default. A download manager that silently made itself the handler for a file
// type would be behaving like the software people uninstall.
//
// Portable mode registers nothing at all: the whole point of running from a USB
// stick is to leave the host machine unchanged, and a registry key that outlives
// the stick would point at an executable that is no longer there.
//
// Every function is a no-op returning an empty report on platforms other than
// Windows, so callers need no #ifdef.
namespace shellint {

struct Entry {
    QString what;      // "Folder background menu", ".torrent", ...
    bool    ok = false;
    QString detail;
};

struct Report {
    QVector<Entry> entries;
    bool anyRegistered() const {
        for (const Entry &e : entries)
            if (e.ok)
                return true;
        return false;
    }
};

// Idempotent, and safe to run on every launch: it rewrites the stored paths, so
// a Nexa that was moved, reinstalled or upgraded stops pointing at an
// executable that has gone.
Report registerShellIntegration();

// Remove everything registerShellIntegration() writes. Returns false when some
// key could not be removed (it reports the others as removed regardless).
bool unregisterShellIntegration();

// Is the integration installed AND pointing at this executable? False when it
// points at a different build, which is what makes "re-register on launch"
// meaningful rather than a permanent no-op.
bool isRegistered();

// Testing hook: send every key this module reads and writes to a different
// registry root, so a test can register, inspect the result and unregister
// again without touching the machine's real shell. An empty string restores
// the default. Not for use outside tests -- there is no reason a shipped build
// would write these anywhere else.
void setClassesRootForTesting(const QString &root);

} // namespace shellint
} // namespace nexa
