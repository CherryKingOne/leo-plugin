#!/usr/bin/env python3
"""
从 dsh-stickers 的透明 PNG 生成终端字符画（半块字符 ▀/▄，24 位真彩色），写入 src/art.generated.ts。

用法：python3 scripts/build-art.py <dsh-stickers 仓库目录> [宽度，默认 36]
透明像素不上色，终端背景透出来；每个字符上下各表示一个像素。
结果按角色（blue / black）gzip 后 base64 内嵌，运行时用到才解压。
"""
import base64, gzip, json, os, sys
from PIL import Image

src = sys.argv[1]
width = int(sys.argv[2]) if len(sys.argv) > 2 else 36
root = os.path.join(src, 'assets', 'stickers')


def art(path):
    im = Image.open(path).convert('RGBA')
    h = round(im.height * width / im.width)
    h += h % 2
    im = im.resize((width, h), Image.LANCZOS)
    px = im.load()
    rows = []
    for y in range(0, h, 2):
        row, last = '', None
        for x in range(width):
            t, b = px[x, y], px[x, y + 1]
            ton, bon = t[3] >= 128, b[3] >= 128
            if ton and bon:
                code = f'\x1b[38;2;{t[0]};{t[1]};{t[2]}m\x1b[48;2;{b[0]};{b[1]};{b[2]}m'; ch = '▀'
            elif ton:
                code = f'\x1b[38;2;{t[0]};{t[1]};{t[2]}m\x1b[49m'; ch = '▀'
            elif bon:
                code = f'\x1b[38;2;{b[0]};{b[1]};{b[2]}m\x1b[49m'; ch = '▄'
            else:
                code = '\x1b[0m'; ch = ' '
            if code != last:
                row += code; last = code
            row += ch
        rows.append(row.rstrip(' ') + '\x1b[0m')
    while rows and rows[-1] == '\x1b[0m':
        rows.pop()
    while rows and rows[0] == '\x1b[0m':
        rows.pop(0)
    return rows


out = {}
for variant, sub in (('blue', ''), ('black', 'black')):
    d = os.path.join(root, sub)
    data = {}
    for name in sorted(os.listdir(d)):
        if name.endswith('.png'):
            data[name] = art(os.path.join(d, name))
    out[variant] = base64.b64encode(gzip.compress(json.dumps(data, ensure_ascii=False).encode(), 9)).decode()

ts = ['// 由 scripts/build-art.py 生成，不要手改。素材：dsh-stickers（BSD-3-Clause，© DSH External contributors）',
      f'// 宽度 {width} 列；每个角色一份 gzip + base64 的 JSON：{{ "<文件名>.png": ["行", ...] }}',
      'export const ART_WIDTH = %d' % width,
      'export const ART: Record<string, string> = {']
for k, v in out.items():
    ts.append(f"  {k}: '{v}',")
ts.append('}')
open(os.path.join(os.path.dirname(__file__), '..', 'src', 'art.generated.ts'), 'w').write('\n'.join(ts) + '\n')
print({k: len(v) for k, v in out.items()})
