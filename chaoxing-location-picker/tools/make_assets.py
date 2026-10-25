# -*- coding: utf-8 -*-
"""
生成扩展图标（16/48/128）以及 README 用的界面示意图。
运行：python tools/make_assets.py
"""
import io
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "extension", "icons")
DOC_DIR = os.path.join(ROOT, "docs")
os.makedirs(ICON_DIR, exist_ok=True)
os.makedirs(DOC_DIR, exist_ok=True)

BLUE = (47, 111, 237, 255)
BLUE_DARK = (32, 82, 190, 255)
RED = (230, 69, 69, 255)
INK = (27, 31, 36, 255)
GREY = (107, 119, 135, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_pin(draw, cx, cy, r, color=(255, 255, 255, 255)):
    """在 (cx, cy) 画一个定位针：水滴 + 中间圆孔。"""
    head_r = r
    # 水滴主体：圆 + 三角
    draw.ellipse([cx - head_r, cy - head_r * 1.9, cx + head_r, cy + head_r * 0.1], fill=color)
    draw.polygon(
        [
            (cx - head_r * 0.72, cy - head_r * 0.62),
            (cx + head_r * 0.72, cy - head_r * 0.62),
            (cx, cy + head_r * 1.35),
        ],
        fill=color,
    )
    # 中间孔
    hole = head_r * 0.38
    draw.ellipse([cx - hole, cy - head_r * 0.9 - hole, cx + hole, cy - head_r * 0.9 + hole], fill=BLUE)


def make_icon(size):
    scale = 8  # 超采样，保证小图标边缘平滑
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = s * 0.04
    rounded_rect(d, [pad, pad, s - pad, s - pad], radius=s * 0.24, fill=BLUE)
    draw_pin(d, s / 2, s * 0.46, s * 0.19)
    # 底部阴影小椭圆，强调"落点"
    d.ellipse([s * 0.36, s * 0.76, s * 0.64, s * 0.83], fill=(255, 255, 255, 90))
    return img.resize((size, size), Image.LANCZOS)


for sz in (16, 48, 128):
    make_icon(sz).save(os.path.join(ICON_DIR, "icon%d.png" % sz))
    print("icon%d.png" % sz)


# ---------------------------------------------------------------------------
# 界面示意图
# ---------------------------------------------------------------------------

def load_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_preview():
    W, H = 1040, 1010
    img = Image.new("RGB", (W, H), (238, 242, 245))
    d = ImageDraw.Draw(img)
    f_title = load_font(22, True)
    f_norm = load_font(15)
    f_small = load_font(14)
    f_tiny = load_font(12)

    px, py, pw, ph = 30, 30, 520, 950

    # 页面背景（模拟被注入的网页）
    d.rectangle([0, 0, W, H], fill=(244, 247, 250))

    # ---- 面板 ----
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=14, fill=(255, 255, 255), outline=(214, 222, 233), width=2)

    # 标题栏
    d.rounded_rectangle([px, py, px + pw, py + 54], radius=14, fill=(245, 247, 251))
    d.rectangle([px, py + 40, px + pw, py + 54], fill=(245, 247, 251))
    d.line([px, py + 54, px + pw, py + 54], fill=(227, 232, 240), width=1)
    d.text((px + 18, py + 16), "自由选点签到", font=f_title, fill=INK)
    # 齿轮与关闭：用矢量图形画，避免字体缺字
    gx, gy = px + pw - 78, py + 27
    d.ellipse([gx - 9, gy - 9, gx + 9, gy + 9], outline=GREY, width=2)
    for k in range(8):
        a = k * math.pi / 4
        d.line([gx + 9 * math.cos(a), gy + 9 * math.sin(a), gx + 13 * math.cos(a), gy + 13 * math.sin(a)], fill=GREY, width=3)
    gx2 = px + pw - 34
    d.line([gx2 - 8, gy - 8, gx2 + 8, gy + 8], fill=GREY, width=3)
    d.line([gx2 - 8, gy + 8, gx2 + 8, gy - 8], fill=GREY, width=3)

    # ---- 地图 ----
    mx0, my0, mx1, my1 = px + 12, py + 68, px + pw - 12, py + 68 + 360
    d.rectangle([mx0, my0, mx1, my1], fill=(238, 244, 243), outline=(210, 220, 225))
    # 地块
    d.polygon([(mx0, my0 + 150), (mx0 + 150, my0 + 96), (mx0 + 300, my0 + 170), (mx1, my0 + 120), (mx1, my1), (mx0, my1)],
              fill=(219, 233, 223))
    d.polygon([(mx0, my0 + 260), (mx0 + 210, my0 + 220), (mx1, my0 + 300), (mx1, my1), (mx0, my1)],
              fill=(206, 224, 212))
    # 水面
    d.polygon([(mx0 + 330, my1), (mx0 + 400, my0 + 210), (mx1, my0 + 180), (mx1, my1)], fill=(206, 226, 236))
    # 路网
    for i in range(1, 7):
        y = my0 + i * 52
        d.line([mx0, y, mx1, y - 12], fill=(255, 255, 255), width=7)
        d.line([mx0, y, mx1, y - 12], fill=(240, 226, 210), width=3)
    for i in range(1, 8):
        x = mx0 + i * 66
        d.line([x, my0, x + 24, my1], fill=(255, 255, 255), width=7)
        d.line([x, my0, x + 24, my1], fill=(240, 226, 210), width=3)
    # 主干道
    d.line([mx0, my0 + 210, mx1, my0 + 150], fill=(255, 245, 225), width=14)
    d.line([mx0, my0 + 210, mx1, my0 + 150], fill=(247, 202, 130), width=6)

    # 选点标记（面板地图中心）
    cx, cy = (mx0 + mx1) // 2, (my0 + my1) // 2
    d.ellipse([cx - 22, cy - 66, cx + 22, cy - 22], fill=(0, 0, 0, 40))
    d.ellipse([cx - 13, cy - 68, cx + 13, cy - 42], fill=RED)
    d.polygon([(cx - 10, cy - 52), (cx + 10, cy - 52), (cx, cy - 22)], fill=RED)
    d.ellipse([cx - 5, cy - 60, cx + 5, cy - 50], fill=(255, 255, 255))
    d.ellipse([cx - 8, cy - 26, cx + 8, cy - 18], fill=(0, 0, 0, 45))

    # 提示条 + 缩放 + 坐标
    d.rounded_rectangle([mx0 + 10, my0 + 10, mx0 + 250, my0 + 40], radius=6, fill=(28, 36, 48))
    d.text((mx0 + 20, my0 + 18), "拖动地图移动，单击落点", font=f_tiny, fill=(255, 255, 255))
    for i, ch in enumerate(["+", "−"]):
        bx = mx1 - 44
        by = my0 + 10 + i * 38
        d.rounded_rectangle([bx, by, bx + 32, by + 32], radius=6, fill=(255, 255, 255), outline=(220, 226, 235))
        d.text((bx + 11, by + 6), ch, font=f_norm, fill=(34, 48, 63))
    d.rounded_rectangle([mx0 + 10, my1 - 40, mx0 + 330, my1 - 10], radius=6, fill=(28, 36, 48))
    d.text((mx0 + 20, my1 - 32), "30.123456, 120.123456  ·  GCJ02  ·  z16.0", font=f_tiny, fill=(255, 255, 255))
    # 比例尺
    d.rectangle([mx1 - 150, my1 - 36, mx1 - 20, my1 - 12], fill=(255, 255, 255))
    d.line([mx1 - 144, my1 - 20, mx1 - 26, my1 - 20], fill=(51, 68, 85), width=2)
    d.text((mx1 - 130, my1 - 34), "100 m", font=f_tiny, fill=(34, 48, 63))

    # ---- 表单 ----
    y = my1 + 22
    # 常用点 chips
    d.text((px + 16, y), "常用点：", font=f_small, fill=GREY)
    chip_x = px + 78
    for label, active in [("图书馆", True), ("三教 201", False), ("宿舍 6 号楼", False)]:
        tw = d.textlength(label, font=f_small)
        w = tw + 24
        d.rounded_rectangle([chip_x, y - 4, chip_x + w, y + 22], radius=13,
                            fill=BLUE if active else (255, 255, 255),
                            outline=BLUE if active else (207, 215, 227))
        d.text((chip_x + 12, y + 1), label, font=f_small, fill=(255, 255, 255) if active else INK)
        chip_x += w + 10

    def field(label, value, y, tag=None):
        d.text((px + 16, y + 6), label, font=f_small, fill=(74, 85, 99))
        bx0 = px + 92
        d.rounded_rectangle([bx0, y, px + pw - 16, y + 32], radius=7, fill=(255, 255, 255), outline=(207, 215, 227))
        d.text((bx0 + 10, y + 7), value, font=f_small, fill=INK)
        if tag:
            d.text((px + pw - 16 - d.textlength(tag, font=f_tiny) - 10, y + 9), tag, font=f_tiny, fill=(150, 160, 175))

    y += 42
    field("纬度 lat", "30.123456", y)
    y += 40
    field("经度 lon", "120.123456", y)
    y += 40
    # 按钮行
    bx = px + 92
    for label, primary in [("解析输入", False), ("按地址搜索", False), ("+ 存为常用点", False)]:
        tw = d.textlength(label, font=f_small)
        w = tw + 26
        d.rounded_rectangle([bx, y, bx + w, y + 32], radius=7,
                            fill=(233, 238, 247) if not primary else BLUE)
        d.text((bx + 13, y + 7), label, font=f_small, fill=(34, 48, 63) if not primary else (255, 255, 255))
        bx += w + 8
    y += 44
    field("签到地址", "XX大学 图书馆", y)
    y += 46

    # 状态框
    d.rounded_rectangle([px + 16, y, px + pw - 16, y + 106], radius=8, fill=(230, 247, 237))
    d.text((px + 28, y + 12), "网页请求定位 → 已返回选点 (30.123456, 120.123456)", font=f_small, fill=(18, 104, 60))
    d.text((px + 28, y + 36), "activeId：123456789      fid：1403      uid：88888888", font=f_small, fill=(18, 104, 60))
    d.text((px + 28, y + 60), "页面定位调用：2 次 · 参数改写：1 次", font=f_small, fill=(18, 104, 60))
    d.text((px + 28, y + 82), "捕获到签到请求：/pptSign/stuSignajax?activeId=123456789", font=f_tiny, fill=(18, 104, 60))
    y += 120

    # 折叠的「粘贴解析」
    d.line([px + 16, y, px + pw - 16, y], fill=(227, 232, 240), width=1)
    d.text((px + 16, y + 12), "▸ 识别不到签到编号？把签到消息/链接粘进来", font=f_small, fill=(74, 85, 99))

    # ---- 底部按钮 ----
    by = py + ph - 62
    d.line([px, by - 10, px + pw, by - 10], fill=(227, 232, 240), width=1)
    d.rounded_rectangle([px, by - 10, px + pw, py + ph], radius=14, fill=(250, 251, 253))
    labels = ["试运行", "写入页面并让网页签到", "直接签到"]
    weights = [58, 156, 74]
    total_w = pw - 32 - 16
    wsum = sum(weights)
    bw_list = [max(60, int(total_w * w / wsum)) for w in weights]
    # 修正舍入误差，保证总宽刚好
    bw_list[-1] += total_w - sum(bw_list)
    x0 = px + 16
    for label, kind, bw in zip(labels, ["ghost", "normal", "primary"], bw_list):
        fill = (255, 255, 255) if kind == "ghost" else ((233, 238, 247) if kind == "normal" else BLUE)
        outline = (207, 215, 227) if kind == "ghost" else None
        d.rounded_rectangle([x0, by, x0 + bw, by + 40], radius=8, fill=fill, outline=outline)
        txt = label
        while d.textlength(txt, font=f_small) > bw - 16 and len(txt) > 4:
            txt = txt[:-1]
        col = (255, 255, 255) if kind == "primary" else (34, 48, 63)
        d.text((x0 + (bw - d.textlength(txt, font=f_small)) / 2, by + 11), txt, font=f_small, fill=col)
        x0 += bw + 8

    # ---- 悬浮按钮 ----
    fx, fy = px + pw + 34, py + ph - 150
    d.ellipse([fx + 2, fy + 6, fx + 62, fy + 66], fill=(200, 208, 218))
    d.ellipse([fx, fy, fx + 60, fy + 60], fill=(31, 157, 85))
    d.text((fx + 13, fy + 14), "选点", font=f_small, fill=(255, 255, 255))
    d.text((fx + 13, fy + 32), "签到", font=f_small, fill=(255, 255, 255))
    d.text((fx - 4, fy + 72), "已生效", font=f_small, fill=GREY)

    # ---- 右侧说明 ----
    tx = px + pw + 116
    d.text((tx, py + 6), "工作方式", font=f_title, fill=INK)
    steps = [
        ("1", "电脑浏览器登录 i.chaoxing.com，等老师发布签到"),
        ("2", "页面右下角圆钮 → 地图上自由选点"),
        ("3", "有签到入口：「写入页面并让网页签到」"),
        ("", "再点页面上原来的签到按钮"),
        ("4", "没入口：「直接签到」用 Cookie 直接提交"),
        ("", "识别不到编号就把签到消息粘进「粘贴解析」"),
    ]
    ly = py + 52
    for num, text in steps:
        if num:
            d.ellipse([tx, ly + 4, tx + 20, ly + 24], fill=BLUE)
            d.text((tx + 6, ly + 7), num, font=f_small, fill=(255, 255, 255))
        d.text((tx + 30, ly + 5), text, font=f_norm, fill=(60, 71, 89))
        ly += 32

    ly += 14
    d.rounded_rectangle([tx, ly, W - 30, ly + 150], radius=10, fill=(255, 246, 229), outline=(247, 222, 176))
    d.text((tx + 14, ly + 12), "注意", font=f_small, fill=(138, 90, 0))
    notes = [
        "签到属于考勤行为，请遵守学校相关规定；",
        "仅供本人账号与设备使用，勿代他人签到；",
        "若服务端启用了更强校验（额外签名、",
        "设备指纹、IP 归属地比对等），纯网页端",
        "方案可能失效，届时只能用官方 APP。",
    ]
    for i, t in enumerate(notes):
        d.text((tx + 14, ly + 38 + i * 22), t, font=f_tiny, fill=(138, 90, 0))

    out = os.path.join(DOC_DIR, "ui-preview.png")
    img.save(out)
    print("docs/ui-preview.png", img.size)


make_preview()
