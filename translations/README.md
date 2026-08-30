# Nexa translations

Nexa's interface is fully externalised: every user-visible string in `src/ui/`
goes through `tr()`, and the files here are the translation sources.

## State

The `.ts` files carry **all 212 source strings** with empty (`unfinished`)
translations. Nexa therefore ships in English today; adding a language is a
content task, not a code change.

## Adding or updating a translation

1. Refresh the source strings after any UI change:
   ```bash
   python3 tools/extract-translations.py          # no Qt tools needed
   # or, with Qt's own tooling installed:
   lupdate-qt6 src -ts translations/nexa_*.ts
   ```
   Existing translations are preserved; only new strings are added.
2. Translate `translations/nexa_<lang>.ts` in **Qt Linguist**, or any XML editor —
   fill each `<translation>` and drop its `type="unfinished"` attribute.
3. Build. When Qt LinguistTools is present, CMake compiles every `.ts` to a `.qm`
   and installs it into `share/nexa/translations`; without it the build still
   succeeds and the UI stays English.

## How a language is chosen at runtime

`src/ui/Localization.cpp` loads, in order: the language saved in
**Settings → Language**, else the system locale. It tries the full tag first
(`pt_BR`) then the bare language (`pt`), searching the app directory,
`share/nexa/translations`, and the compiled-in `:/translations` resource. Qt's own
dialog strings load from `qtbase_<lang>` where the Qt translations are installed.

Urdu, Arabic, Farsi and Hebrew additionally switch the whole layout to
right-to-left.

## Notes for translators

- Keep `%1`, `%2` … placeholders — they are substituted at runtime and their
  order may legitimately differ from English.
- Keep the trailing ellipsis (`…`) on menu items that open a dialog; that is a
  platform convention, not decoration.
- Speed/size units (`MB`, `B/s`) are formatted separately in `UiHelpers.cpp` and
  are intentionally not translated.
