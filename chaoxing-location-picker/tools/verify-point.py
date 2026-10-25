# -*- coding: utf-8 -*-
"""
交叉验证：用高德瓦片（无偏移的 GCJ-02 底图）把上一步算出的坐标画出来，
目视确认它确实落在河北师范大学裕华校区上。

输出一张 PNG，同时把坐标点标在瓦片中心。
运行：python tools/verify-point.py
"""
import io
import math
import os
import sys
import urllib.request

from PIL import Image, ImageDraw

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(ROOT, 'docs')
os.makedirs(DOC, exist_ok=True)

# 上一步得到的 GCJ-02 坐标
LAT, LON = 37.997180, 114.520905
ZOOM = 15
TILE = 256


def lonlat_to_tile(lat, lon, z):
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def fetch_tile(z, x, y, sub='1'):
    url = ('https://webrd0%s.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=%d&y=%d&z=%d'
           % (sub, x, y, z))
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return Image.open(io.BytesIO(r.read())).convert('RGB')


fx, fy = lonlat_to_tile(LAT, LON, ZOOM)
cx, cy = int(fx), int(fy)
print('瓦片坐标 (小数):', round(fx, 4), round(fy, 4), '→ 中心瓦片', cx, cy)

W, H = 5, 3
canvas = Image.new('RGB', (W * TILE, H * TILE), (238, 240, 238))
ok = 0
for j in range(H):
    for i in range(W):
        tx = cx - W // 2 + i
        ty = cy - H // 2 + j
        try:
            canvas.paste(fetch_tile(ZOOM, tx, ty), (i * TILE, j * TILE))
            ok += 1
        except Exception as e:
            print('  瓦片 %d/%d/%d 失败: %s' % (ZOOM, tx, ty, e))
            d = ImageDraw.Draw(canvas)
            d.rectangle([i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE], outline=(200, 200, 200))

print('成功加载瓦片: %d/%d' % (ok, W * H))

# 精确位置：相对于画布左上角
px = (fx - (cx - W // 2)) * TILE
py = (fy - (cy - H // 2)) * TILE
d = ImageDraw.Draw(canvas)
r = 10
d.ellipse([px - r, py - r, px + r, py + r], outline=(230, 40, 40), width=4)
d.line([px - r - 14, py, px + r + 14, py], fill=(230, 40, 40), width=2)
d.line([px, py - r - 14, px, py + r + 14], fill=(230, 40, 40), width=2)
d.rectangle([4, 4, 470, 46], fill=(255, 255, 255))
d.text((10, 10), 'GCJ-02  %.6f, %.6f   (高德底图, z%d)' % (LAT, LON, ZOOM), fill=(20, 20, 20))
d.text((10, 28), '红圈 = 坐标点，应落在河北师范大学(裕华校区) 校园内', fill=(90, 90, 90))

out = os.path.join(DOC, 'hebtu-point-check.png')
canvas.save(out)
print('已保存:', out, canvas.size)
