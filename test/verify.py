"""Checks the cleaned files with an independent decoder (Pillow):
pixels identical, rotation kept, color profile kept, private data gone."""
import os
import sys
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "fixtures")
OUT = os.path.join(HERE, "out")

FORBIDDEN = [b"iPhone", b"Apple", b"Jane", b"SN123", b"TrainedAlgorithmic", b"c2pa", b"Photoshop",
             b"xmpmeta", b"parameters", b"Sampler", b"Plainshot test comment", b"San Francisco",
             b"SEFH", b"Re_Edit", b"2024:06:01", b"MPF\0", b"Stable Diffusion"]
ROTATION = {"phone.jpg": 6, "progressive.jpg": None, "ai.png": 8, "photo.webp": 3, "clean.jpg": None}
failed = False

for name, rot in ROTATION.items():
    a = Image.open(os.path.join(SRC, name))
    b = Image.open(os.path.join(OUT, name))
    raw = open(os.path.join(OUT, name), "rb").read()
    problems = []
    if a.convert("RGB").tobytes() != b.convert("RGB").tobytes():
        problems.append("pixels changed")
    exif = dict(b.getexif())
    if rot is None:
        if exif:
            problems.append(f"unexpected EXIF {exif}")
    elif exif != {274: rot}:
        problems.append(f"EXIF should be only orientation {rot}, got {exif}")
    if a.info.get("icc_profile") != b.info.get("icc_profile"):
        problems.append("color profile changed")
    for word in FORBIDDEN:
        if word in raw:
            problems.append(f"still contains {word!r}")
    if name.endswith(".jpg") and raw.count(b"\xff\xd8\xff") != 1:
        problems.append("embedded extra image still present")
    b.load()
    print(f"{name}: {'OK' if not problems else ', '.join(problems)}")
    failed |= bool(problems)

with zipfile.ZipFile(os.path.join(OUT, "all.zip")) as z:
    bad = z.testzip()
    names = z.namelist()
    print(f"all.zip: {'OK' if bad is None else 'CRC error in ' + bad} ({len(names)} files)")
    failed |= bad is not None or len(names) != len(ROTATION)

sys.exit(1 if failed else 0)
