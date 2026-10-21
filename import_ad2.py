#!/usr/bin/env python3
"""
Import an AlarmDecoder settings export (.tar.gz) from the command line.

Loads zones, notifications, message templates and settings from the archive into
the app's data store (the same store the webapp's Settings -> Import uses). The
webapp also offers this through the browser; this CLI is for a one-shot migration
without logging in.

Usage:
  python import_ad2.py export.tar.gz                 # import into ./data
  python import_ad2.py export.tar.gz --data ./data   # choose the data dir
"""

import argparse
import os
import sys

import adio
from store import Store

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Import AlarmDecoder export into the data store.")
    ap.add_argument("export", help="path to alarmdecoder-export-*.tar.gz")
    ap.add_argument("--data", default=os.environ.get("EVL_DATA", os.path.join(HERE, "data")),
                    help="data directory to import into (default: ./data)")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.export):
        sys.exit("No such file: %s" % args.export)

    store = Store(args.data).load()
    summary = adio.import_path(store, args.export)

    print("Imported into %s:" % args.data)
    for name, count in sorted(summary.items()):
        print("  %-28s %s rows" % (name, count))
    print("  zones:         %d" % len(store.zones))
    print("  notifications: %d" % len(store.notifications))
    print("Done. Restart the app (or it will pick these up on next load).")


if __name__ == "__main__":
    main()
