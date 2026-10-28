"""Build and verify TRMNL's flat private-plugin archive. Standard library only."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

root = Path(__file__).resolve().parents[1]
src = root / 'TRMNL/src'
names = ('settings.yml', 'full.liquid', 'transform.js')
if {p.name for p in src.iterdir() if p.is_file()} != set(names):
    raise SystemExit('Unexpected or missing plugin source file')
output = root / 'dist/STONKS.zip'
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for name in names:
        data = (src / name).read_bytes()
        if not data or len(data) > 100_000:
            raise SystemExit(f'{name} must be 1–100000 bytes')
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
with ZipFile(output) as archive:
    if archive.testzip() is not None or set(archive.namelist()) != set(names):
        raise SystemExit('Invalid import archive')
    for name in names:
        if archive.read(name) != (src / name).read_bytes():
            raise SystemExit(f'Archive/source mismatch: {name}')
print(f'Created {output} ({output.stat().st_size} bytes; {len(names)} root-level files; CRC verified)')
