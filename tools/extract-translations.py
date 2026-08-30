#!/usr/bin/env python3
"""Generate Qt .ts translation sources from tr("...") calls in the Nexa UI.

Qt's own `lupdate` is the canonical tool, and CI uses it when Qt LinguistTools is
installed. This standalone extractor exists so the .ts files can be regenerated
on a machine without the Qt dev tools, and so a fresh checkout always ships a
complete, up-to-date set of source strings for translators.

Usage:  python3 tools/extract-translations.py [--languages ur,hi,ar]

Existing translations are PRESERVED; only new source strings are added, and
strings that disappeared from the code are dropped.
"""
import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIRS = [os.path.join(ROOT, 'src')]
OUT_DIR = os.path.join(ROOT, 'translations')

# tr("literal") — handles escaped quotes; tr() with a variable argument is skipped.
TR_RE = re.compile(r'\btr\(\s*"((?:[^"\\]|\\.)*)"')
# "void MainWindow::foo(" / "MainWindow::MainWindow(" -> the context is the class.
DEF_RE = re.compile(r'^[A-Za-z_][\w:<>,\s\*&]*?\b([A-Z]\w+)::[~\w]+\s*\(')
CLASS_RE = re.compile(r'^\s*class\s+([A-Z]\w+)\s*(?::|\{)')

DEFAULT_LANGS = ['ur', 'hi', 'ar', 'es', 'pt_BR', 'id', 'ru', 'tr', 'fr', 'de', 'zh_CN']


def collect():
    """-> {context: {source: [(file, line), ...]}}"""
    found = {}
    for base in SRC_DIRS:
        for dirpath, _dirs, files in os.walk(base):
            for name in sorted(files):
                if not name.endswith(('.cpp', '.h')):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, ROOT)
                context = os.path.splitext(name)[0]
                with open(path, encoding='utf-8') as fh:
                    for lineno, line in enumerate(fh, 1):
                        m = DEF_RE.match(line) or CLASS_RE.match(line)
                        if m:
                            context = m.group(1)
                        for lit in TR_RE.findall(line):
                            found.setdefault(context, {}).setdefault(lit, []).append((rel, lineno))
    return found


def existing_translations(path):
    """Keep whatever a translator already wrote: {(context, source): text}."""
    if not os.path.exists(path):
        return {}
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        print('  ! %s is not valid XML (%s); regenerating' % (os.path.basename(path), exc))
        return {}
    kept = {}
    for ctx in tree.getroot().findall('context'):
        name = ctx.findtext('name') or ''
        for msg in ctx.findall('message'):
            src = msg.findtext('source') or ''
            tr = msg.find('translation')
            if tr is not None and (tr.text or '').strip():
                kept[(name, src)] = tr.text
    return kept


def unescape(lit):
    return (lit.replace('\\n', '\n').replace('\\t', '\t')
               .replace('\\"', '"').replace('\\\\', '\\'))


def write_ts(lang, data):
    path = os.path.join(OUT_DIR, 'nexa_%s.ts' % lang)
    kept = existing_translations(path)
    root = ET.Element('TS', {'version': '2.1', 'language': lang, 'sourcelanguage': 'en'})
    n_total = n_done = 0
    for context in sorted(data):
        ctx_el = ET.SubElement(root, 'context')
        ET.SubElement(ctx_el, 'name').text = context
        for source in sorted(data[context]):
            msg = ET.SubElement(ctx_el, 'message')
            first_file, first_line = data[context][source][0]
            ET.SubElement(msg, 'location',
                          {'filename': '../' + first_file, 'line': str(first_line)})
            text = unescape(source)
            ET.SubElement(msg, 'source').text = text
            tr_el = ET.SubElement(msg, 'translation')
            n_total += 1
            prior = kept.get((context, text))
            if prior and prior.strip():
                tr_el.text = prior
                n_done += 1
            else:
                tr_el.set('type', 'unfinished')
    ET.indent(root, space='    ')
    xml = ET.tostring(root, encoding='unicode')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n' + xml + '\n')
    print('  %-24s %4d strings, %d translated' % (os.path.basename(path), n_total, n_done))
    return n_total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--languages', default=','.join(DEFAULT_LANGS))
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    data = collect()
    strings = sum(len(v) for v in data.values())
    print('Extracted %d unique strings from %d contexts' % (strings, len(data)))
    if not strings:
        print('No tr() strings found - nothing to do', file=sys.stderr)
        return 1
    for lang in [l for l in args.languages.split(',') if l.strip()]:
        write_ts(lang.strip(), data)
    return 0


if __name__ == '__main__':
    sys.exit(main())
