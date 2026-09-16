#pragma once
#include <QDialog>
#include <QStringList>

class QPlainTextEdit;
class QLabel;
class QListWidget;
class QDialogButtonBox;

namespace nexa {

class DownloadEngine;

// IDM-style batch download: paste a list of addresses, or one address carrying a
// numeric range like https://site.com/scan[001-240].jpg, and queue the lot.
//
// The expansion itself is DownloadEngine::expandPattern -- the same code the
// command line and the remote dashboard already use, so the dialog cannot
// disagree with them about what a pattern means. What the dialog adds is the
// part that was missing: showing the person what their pattern actually expands
// to BEFORE two hundred downloads appear in the list. A range is easy to get
// wrong by an order of magnitude, and a queue is a slow place to find that out.
class BatchDownloadDialog : public QDialog {
    Q_OBJECT
public:
    // How many expanded rows the preview lists before eliding, and the hard
    // ceiling on the expansion itself -- a fat-fingered [1-999999] must not
    // build a million-entry list just to render a preview of its first twelve.
    static constexpr int kPreviewRows    = 12;
    static constexpr int kPreviewCeiling = 10000;

    explicit BatchDownloadDialog(DownloadEngine *engine, QWidget *parent = nullptr);

    // Addresses queued when the dialog was accepted (empty otherwise).
    QStringList queued() const { return m_queued; }

private slots:
    void refreshPreview();
    void queueThem();

public:
    // The decision the dialog is built around, as a pure function: which
    // addresses does this text actually queue? Public and static so it can be
    // tested without a widget, an engine or a database -- the cap and the
    // scheme filter are the parts worth pinning, and neither needs a window to
    // be wrong. `truncated` is set when the ceiling cut the list short.
    static QStringList expandInput(const QString &text, bool *truncated = nullptr);

private:


    DownloadEngine   *m_engine;
    QPlainTextEdit   *m_input = nullptr;
    QLabel           *m_count = nullptr;
    QListWidget      *m_preview = nullptr;
    QDialogButtonBox *m_buttons = nullptr;
    QStringList       m_queued;
};

} // namespace nexa
