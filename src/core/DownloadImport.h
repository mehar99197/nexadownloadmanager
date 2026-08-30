#pragma once

#include <QString>
#include <QVector>
#include "core/Types.h"

namespace nexa {

// One download recovered from another manager's export file.
struct ImportedDownload {
    QString    url;
    QString    fileName;   // suggested name, when the export carried one
    HeaderList headers;    // referer / user-agent / cookie, when present
};

// Parsing exports from the managers people switch away from. All functions are
// pure (text in, list out) so they can be unit-tested without any file I/O:
//
//   * IDM (.ef2)          — "<" ... ">" blocks: URL line then header lines
//   * JDownloader (.crawljob / .txt) — key=value blocks separated by blank lines
//   * Plain lists (.txt/.csv) — one URL per line, "#" comments ignored
//
// Every parser is tolerant of stray whitespace and CRLF, ignores anything that
// isn't an http(s)/ftp/magnet URL, and de-duplicates while preserving order.
namespace downloadimport {

QVector<ImportedDownload> parseIdmEf2(const QString &text);
QVector<ImportedDownload> parseCrawljob(const QString &text);
QVector<ImportedDownload> parsePlainList(const QString &text);

// Pick a parser from the file's extension and content, then parse.
QVector<ImportedDownload> parseAny(const QString &fileName, const QString &text);

// File-dialog filter covering every supported export.
QString fileDialogFilter();

} // namespace downloadimport
} // namespace nexa
