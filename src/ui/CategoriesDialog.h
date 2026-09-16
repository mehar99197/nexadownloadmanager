#pragma once
#include <QDialog>
#include <QVector>

#include "core/Categories.h"

class QListWidget;
class QLabel;
class QPushButton;

namespace nexa {

class DownloadEngine;

// "Download categories" — the rules that decide which folder a download lands
// in. The list is the priority order: it is read top to bottom and the first
// category whose site or file-type rule fits wins, which is what makes dragging
// a row upwards a meaningful act rather than cosmetics.
//
// Reordering writes through on drop; adding, editing and deleting write through
// on OK from the row editor. There is no separate Save button because a
// half-applied category list is worse than no change at all.
class CategoriesDialog : public QDialog {
    Q_OBJECT
public:
    explicit CategoriesDialog(DownloadEngine *engine, QWidget *parent = nullptr);

private:
    void buildUi();
    void reload();              // pull the engine's list into the widget
    void persistOrder();        // after a drag: renumber priorities
    void addCategory();
    void editSelected();
    void deleteSelected();
    void updateButtons();
    void showPreview();         // "a file named X from Y would go to Z"

    // The row editor. Returns false when the user cancels.
    bool editCategory(Category &cat, bool isNew);

    Category selectedCategory() const;

    DownloadEngine *m_engine;
    QListWidget    *m_list    = nullptr;
    QLabel         *m_detail  = nullptr;   // rules of the selected row
    QPushButton    *m_edit    = nullptr;
    QPushButton    *m_delete  = nullptr;
    bool            m_reloading = false;   // suppress drop handling during reload
};

} // namespace nexa
