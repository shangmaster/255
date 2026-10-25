# -*- coding: utf-8 -*-
"""
查询 / 交叉验证「河北师范大学（裕华校区）」坐标，并输出各坐标系下的值。

为什么要换算：OpenStreetMap 的数据是 WGS-84，而国内地图（高德/腾讯/学习通）
用的是 GCJ-02，两者在石家庄相差约 500 米。签到按坐标算距离，差这个量级会失败。

运行：python tools/lookup-hebtu.py
"""
import io
import json
import sys
import urllib.parse
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

UA = {'User-Agent': 'chaoxing-location-picker/1.0 (personal use)',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept': 'application/json'}


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def http_post(url, data, timeout=60):
    body = urllib.parse.urlencode(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


# ---------- 坐标系换算（与扩展 lib.js 同一套算法） ----------

PI = 3.141592653589793
A = 6378245.0
EE = 0.00669342162296594323


def out_of_china(lat, lon):
    return not (73.66 < lon < 135.05 and 3.86 < lat < 53.55)


def _tlat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * (abs(x) ** 0.5)
    ret += (20.0 * __import__('math').sin(6.0 * x * PI) + 20.0 * __import__('math').sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * __import__('math').sin(y * PI) + 40.0 * __import__('math').sin(y / 3.0 * PI)) * 2.0 / 3.0
    ret += (160.0 * __import__('math').sin(y / 12.0 * PI) + 320 * __import__('math').sin(y * PI / 30.0)) * 2.0 / 3.0
    return ret


def _tlon(x, y):
    import math
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * (abs(x) ** 0.5)
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * PI) + 40.0 * math.sin(x / 3.0 * PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * PI) + 300.0 * math.sin(x / 30.0 * PI)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat, lon):
    import math
    if out_of_china(lat, lon):
        return lat, lon
    dlat = _tlat(lon - 105.0, lat - 35.0)
    dlon = _tlon(lon - 105.0, lat - 35.0)
    rad = lat / 180.0 * PI
    magic = math.sin(rad)
    magic = 1 - EE * magic * magic
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sq) * PI)
    dlon = (dlon * 180.0) / (A / sq * math.cos(rad) * PI)
    return lat + dlat, lon + dlon


def haversine(a, b):
    import math
    R = 6371008.8
    p1, l1 = a
    p2, l2 = b
    dp = math.radians(p2 - p1)
    dl = math.radians(l2 - l1)
    h = math.sin(dp / 2) ** 2 + math.cos(math.radians(p1)) * math.cos(math.radians(p2)) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1, h ** 0.5))


# ---------- 1) Nominatim ----------

print('=== 1) Nominatim（OSM 官方地理编码）===')
results = []
for q in ['河北师范大学', '河北师范大学 裕华校区', '河北师范大学新校区']:
    try:
        body = http_get('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + urllib.parse.quote(q))
        items = json.loads(body)
        print('  查询 %-22s -> %d 条' % (q, len(items)))
        for it in items:
            print('      %s, %s  | %s' % (it.get('lat'), it.get('lon'), (it.get('display_name') or '')[:100]))
            results.append((float(it['lat']), float(it['lon']), it.get('display_name') or ''))
    except Exception as e:
        print('  查询 %-22s 失败: %s' % (q, e))

# ---------- 2) Overpass（OSM 要素） ----------

print()
print('=== 2) Overpass（直接查 OSM 要素，交叉验证）===')
overpass = []
try:
    q = '[out:json][timeout:50];nwr["name"~"河北师范大学"](37.8,114.3,38.2,114.7);out center tags 10;'
    body = http_post('https://overpass-api.de/api/interpreter', {'data': q})
    data = json.loads(body)
    for el in data.get('elements', []):
        c = el.get('center') or {'lat': el.get('lat'), 'lon': el.get('lon')}
        name = (el.get('tags') or {}).get('name', '?')
        if c.get('lat'):
            print('  %-34s %s, %s' % (name, c['lat'], c['lon']))
            overpass.append((float(c['lat']), float(c['lon']), name))
except Exception as e:
    print('  Overpass 失败:', e)

# ---------- 汇总 ----------

print()
print('=== 3) 结论 ===')
if not results:
    print('  没查到结果')
    raise SystemExit(1)

# 取 Nominatim 第一条作为主结果（已用名称精确匹配过）
wlat, wlon, wname = results[0]
glat, glon = wgs84_to_gcj02(wlat, wlon)

print('  名称（OSM 记录）: %s' % wname)
print()
print('  WGS-84（GPS 原始 / OSM 返回）:  %.6f, %.6f' % (wlat, wlon))
print('  GCJ-02（高德/腾讯/学习通用）  :  %.6f, %.6f' % (glat, glon))
print('  两者相差: %.0f 米' % haversine((wlat, wlon), (glat, glon)))
print()
if overpass:
    olat, olon, oname = overpass[0]
    print('  Overpass 交叉验证: %s  %.6f, %.6f' % (oname, olat, olon))
    print('  与 Nominatim 首条相距: %.0f 米' % haversine((wlat, wlon), (olat, olon)))
print()
print('  ==> 填进扩展用这组（扩展默认坐标系是 GCJ-02）:')
print('      lat %s' % round(glat, 6))
print('      lon %s' % round(glon, 6))
