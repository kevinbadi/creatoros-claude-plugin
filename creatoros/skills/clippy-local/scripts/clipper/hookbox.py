#!/usr/bin/env python3
"""Clippy hook box: the on-screen hook drawn like TikTok's own text box.

TikTok's in-app text with a background is what scrollers read as native: one
white shape behind the lines (each line as wide as its own text, the lines
touching), every corner rounded, outer and inner ones alike, in TikTok Sans.
libass can only draw square boxes per line, so the hook is drawn here as a
transparent PNG the size of the frame width and laid over the video.

  hookbox.py TEXT OUT.png --width 1080 --font TikTokSans-SemiBold.ttf
             [--size 62] [--color #000000] [--background #FFFFFF] [--max 0.8]

Prints {"w": ..., "h": ...} of the PNG.
"""
import argparse
import json

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def wrap(text, font, max_w):
    words, lines, line = text.split(), [], ''
    for w in words:
        test = f'{line} {w}'.strip()
        if line and font.getlength(test) > max_w:
            lines.append(line)
            line = w
        else:
            line = test
    if line:
        lines.append(line)
    # Balance a short last line ("widow") with the one before it, as people do by hand.
    if len(lines) >= 2 and font.getlength(lines[-1]) < font.getlength(lines[-2]) * 0.45:
        joined = f'{lines[-2]} {lines[-1]}'.split()
        best = None
        for i in range(1, len(joined)):
            a, b = ' '.join(joined[:i]), ' '.join(joined[i:])
            wa, wb = font.getlength(a), font.getlength(b)
            if max(wa, wb) <= max_w and (best is None or abs(wa - wb) < best[0]):
                best = (abs(wa - wb), a, b)
        if best:
            lines[-2:] = [best[1], best[2]]
    return lines[:3]


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('text')
    ap.add_argument('out')
    ap.add_argument('--width', type=int, default=1080)
    ap.add_argument('--font', required=True)
    ap.add_argument('--size', type=int, default=62)
    ap.add_argument('--color', default='#000000')
    ap.add_argument('--background', default='#FFFFFF')
    ap.add_argument('--max', type=float, default=0.8)
    a = ap.parse_args()

    S = 2  # draw at 2x, then downsample: smooth curves and text edges
    W = a.width * S
    fs = a.size * S
    font = ImageFont.truetype(a.font, fs)
    pad_x = round(fs * 0.36)
    line_h = round(fs * 1.28)
    radius = round(fs * 0.3)
    lines = wrap(' '.join(a.text.split()), font, a.width * a.max * S - 2 * pad_x)
    widths = [font.getlength(l) for l in lines]
    top = radius
    H = top + line_h * len(lines) + radius

    # The shape: one rect per line (touching), then a blur + threshold rounds
    # every corner, the inner ones where two line widths meet included.
    mask = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(mask)
    for i, w in enumerate(widths):
        x0 = (W - w) / 2 - pad_x
        y0 = top + i * line_h
        d.rectangle([x0, y0, x0 + w + 2 * pad_x, y0 + line_h], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius * 0.55)).point(lambda v: 255 if v >= 128 else 0)
    mask = mask.filter(ImageFilter.GaussianBlur(S * 0.6))  # anti-alias the edge

    img = Image.new('RGBA', (W, H), hex_rgb(a.background) + (0,))
    img.putalpha(mask)
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        cy = top + i * line_h + line_h / 2
        d.text((W / 2, cy), l, font=font, fill=hex_rgb(a.color) + (255,), anchor='mm')

    img = img.resize((a.width, H // S), Image.LANCZOS)
    img.save(a.out)
    print(json.dumps({'w': img.width, 'h': img.height, 'lines': len(lines)}))


if __name__ == '__main__':
    main()
