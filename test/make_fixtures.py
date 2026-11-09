"""Builds test photos packed with the kinds of hidden data Unlabel removes.

Needs: pip install pillow piexif
"""
import io
import os
import struct

import piexif
from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
os.makedirs(OUT, exist_ok=True)

XMP = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" '
    'xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" '
    'xmp:CreatorTool="Adobe Photoshop 26.0" xmp:CreateDate="2024-06-01T14:32:10" '
    'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia">'
    '<xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved"/></rdf:Seq></xmpMM:History>'
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
)


def picture(w=400, h=300):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 255 // w, y * 255 // h, (x * y) % 256)
    return img


def exif_bytes(orientation, with_thumb=True):
    def dms(v):
        v = abs(v)
        d = int(v)
        m = int((v - d) * 60)
        s = round(((v - d) * 60 - m) * 60 * 100)
        return ((d, 1), (m, 1), (s, 100))

    thumb = io.BytesIO()
    picture(80, 60).save(thumb, "JPEG")
    data = {
        "0th": {
            piexif.ImageIFD.Make: b"Apple",
            piexif.ImageIFD.Model: b"iPhone 15 Pro",
            piexif.ImageIFD.Software: b"17.5.1",
            piexif.ImageIFD.Orientation: orientation,
            piexif.ImageIFD.Artist: b"Jane Example",
        },
        "Exif": {
            piexif.ExifIFD.DateTimeOriginal: b"2024:06:01 14:32:10",
            piexif.ExifIFD.LensModel: b"iPhone 15 Pro back triple camera",
            piexif.ExifIFD.BodySerialNumber: b"SN123456789",
            piexif.ExifIFD.MakerNote: b"Apple iOS\0" + b"\1" * 40,
        },
        "GPS": {
            piexif.GPSIFD.GPSLatitudeRef: b"N",
            piexif.GPSIFD.GPSLatitude: dms(37.7749),
            piexif.GPSIFD.GPSLongitudeRef: b"W",
            piexif.GPSIFD.GPSLongitude: dms(122.4194),
        },
        "1st": {},
        "thumbnail": thumb.getvalue() if with_thumb else None,
    }
    return piexif.dump(data)


def seg(marker, payload):
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def insert_after_soi(jpeg, *segments):
    return jpeg[:2] + b"".join(segments) + jpeg[2:]


def iptc():
    def ds(n, val):
        v = val.encode()
        return bytes([0x1C, 2, n]) + struct.pack(">H", len(v)) + v

    rec = ds(80, "Jane Example") + ds(90, "San Francisco") + ds(120, "Secret caption")
    if len(rec) % 2:
        rec += b"\0"
    res = b"8BIM" + struct.pack(">H", 0x0404) + b"\0\0" + struct.pack(">I", len(rec)) + rec
    return b"Photoshop 3.0\0" + res


icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

# 1. A phone photo with everything: GPS, camera, dates, AI tags, C2PA, edit history, trailer.
buf = io.BytesIO()
picture().save(buf, "JPEG", quality=92, exif=exif_bytes(6), icc_profile=icc)
jpeg = buf.getvalue()
jpeg = insert_after_soi(
    jpeg,
    seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0" + XMP.encode()),
    seg(0xEB, b"JP\0\x01\0\0\0\x01\0\0\0\x20jumb\0\0\0\x18jumdc2pa\0\x11\0\x10\x80\0\0\xaa\0\x38\x9b\x71c2pa\0"),
    seg(0xED, iptc()),
    seg(0xE2, b"MPF\0" + b"\0" * 32),
    seg(0xFE, b"Unlabel test comment"),
)
second = io.BytesIO()
picture(64, 48).save(second, "JPEG")
jpeg += second.getvalue() + b"SEFHPhotoEditor_Re_Edit_Data"
open(os.path.join(OUT, "phone.jpg"), "wb").write(jpeg)

# 2. A progressive JPEG with plain EXIF and no rotation.
buf = io.BytesIO()
picture(320, 240).save(buf, "JPEG", quality=85, progressive=True, exif=exif_bytes(1, with_thumb=False))
open(os.path.join(OUT, "progressive.jpg"), "wb").write(buf.getvalue())

# 3. An AI image saved as PNG with prompt text, XMP, EXIF rotation and an ICC profile.
from PIL import PngImagePlugin

info = PngImagePlugin.PngInfo()
info.add_text("parameters", "a cat astronaut, Steps: 30, Sampler: Euler a, CFG scale: 7")
info.add_itxt("XML:com.adobe.xmp", XMP)
info.add_text("Software", "Stable Diffusion WebUI")
buf = io.BytesIO()
picture(200, 150).save(buf, "PNG", pnginfo=info, exif=exif_bytes(8, with_thumb=False), icc_profile=icc)
open(os.path.join(OUT, "ai.png"), "wb").write(buf.getvalue())

# 4. A lossless WebP with EXIF, XMP and ICC.
buf = io.BytesIO()
picture(160, 120).save(buf, "WEBP", lossless=True, exif=exif_bytes(3, with_thumb=False), xmp=XMP.encode(), icc_profile=icc)
open(os.path.join(OUT, "photo.webp"), "wb").write(buf.getvalue())

# 5. Already clean.
buf = io.BytesIO()
picture(120, 90).save(buf, "JPEG")
open(os.path.join(OUT, "clean.jpg"), "wb").write(buf.getvalue())

print("fixtures written to", OUT)
