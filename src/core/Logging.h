#pragma once
#include <QString>

// Opt-in troubleshooting log. When enabled (Settings → "Save error logs to a
// file"), qWarning/qCritical/qInfo lines are appended to a small rotating file so
// a user can export them when something misbehaves. Off by default; debug noise
// is never written. Definitions live in main.cpp (single translation unit that
// owns the message-handler install).
namespace nexa {

// Install the message-handler sink ONCE at startup. Reads the persisted on/off
// state via QSettings so logging is active from the first line if enabled.
void installLogging();

// Live on/off, called from Settings when the user toggles the checkbox.
void setLoggingEnabled(bool on);

// Absolute path of the log file (under AppDataLocation), for the "Export logs"
// action — valid whether or not the file exists yet.
QString logFilePath();

} // namespace nexa
