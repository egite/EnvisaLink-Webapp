"""
Import / export of the AlarmDecoder settings archive.

The archive is a gzipped tar containing an `alarmdecoder-export/` directory with
one JSON file per table. We read/write exactly the files the original uses, from
the Store's row format, so an export made here imports into a real AlarmDecoder
(and vice-versa) without translation.
"""

import io
import json
import os
import tarfile
from datetime import datetime

from store import FILES

PREFIX = "alarmdecoder-export"


def export_bytes(store):
    """Return (filename, data_bytes) for a tar.gz export of the store."""
    tables = store.dump_tables()
    filename = "%s-%s.tar.gz" % (PREFIX, datetime.now().strftime("%Y%m%d%H%M%S"))
    buf = io.BytesIO()
    with tarfile.open(mode="w:gz", fileobj=buf) as tar:
        # top-level directory entry, like the original
        info = tarfile.TarInfo(name=PREFIX)
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        for name in FILES:
            payload = json.dumps(tables.get(name, []), indent=4, sort_keys=True).encode("utf-8")
            ti = tarfile.TarInfo(name="%s/%s" % (PREFIX, name))
            ti.size = len(payload)
            ti.mode = 0o644
            tar.addfile(ti, io.BytesIO(payload))
    return filename, buf.getvalue()


def import_fileobj(store, fileobj):
    """Load an AlarmDecoder archive (file-like, r:gz) into the store.

    Returns a summary dict of how many rows each known table contributed.
    """
    tables = {}
    summary = {}
    with tarfile.open(mode="r:gz", fileobj=fileobj) as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            base = os.path.basename(member.name)
            if base in FILES:
                f = tar.extractfile(member)
                if f is None:
                    continue
                data = json.loads(f.read().decode("utf-8"))
                tables[base] = data
                summary[base] = len(data) if isinstance(data, list) else 0
    store.load_tables(tables)
    if not store.messages:
        store.seed_default_messages()
    store.save()
    return summary


def import_path(store, path):
    with open(path, "rb") as f:
        return import_fileobj(store, f)
