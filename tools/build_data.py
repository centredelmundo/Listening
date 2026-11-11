#!/usr/bin/env python3
"""data.js を生成する。

正解・配点は東進の解答速報の表から、大問の開始位置（秒）は音声のアナウンス位置から、
ページ番号は問題PDFから、それぞれ書き起こしたもの。
"""
import json, os

SECTIONS = ['1A', '1B', '2', '3', '4A', '4B', '5', '6A', '6B']
LABEL = {'1A': '第1問A', '1B': '第1問B', '2': '第2問', '3': '第3問', '4A': '第4問A',
         '4B': '第4問B', '5': '第5問', '6A': '第6問A', '6B': '第6問B'}

# 2021〜2024 と 2025〜 で、第1問B・第2問の問題数と第5問 問33の配点が違う
OLD = {'1A': range(1, 5), '1B': range(5, 8), '2': range(8, 12), '3': range(12, 18), '4A': range(18, 26),
       '4B': [26], '5': range(27, 34), '6A': [34, 35], '6B': [36, 37]}
NEW = dict(OLD, **{'1B': range(5, 9), '2': range(9, 12)})
POINTS = {'1A': 4, '1B': 3, '2': 4, '3': 3, '4B': 4, '6A': 3, '6B': 4}
PAGES_OLD = {'1A': [5, 6], '1B': [7, 8, 9], '2': [11, 12, 13, 14], '3': [15, 16], '4A': [17, 18],
             '4B': [19], '5': [21, 22, 23], '6A': [25], '6B': [27, 28]}

YEARS = {
    '2026': dict(
        answers='2334 2122 241 313423 24153461 3 4632522 12 13',
        pages={'1A': [5, 6], '1B': [7, 8, 9, 10], '2': [11, 12, 13], '3': [15, 16], '4A': [17, 18],
               '4B': [19], '5': [21, 22, 23, 25, 26], '6A': [27], '6B': [29, 30]},
        starts=[23.8, 163.1, 283.9, 459.6, 678.3, 877.4, 1014.6, 1409.5, 1559.0], end=1746.8,
        choices={18: 5, 19: 5, 20: 5, 21: 5},
        sizes={'pdf': 491732, 'mp3': 8734465}),
    '2025': dict(
        answers='2421 1413 432 431332 43124265 2 2631514 41 33',
        pages={'1A': [3, 4], '1B': [5, 6, 7, 8], '2': [9, 10, 11], '3': [13, 14], '4A': [15, 16],
               '4B': [17], '5': [19, 20, 21, 23, 24], '6A': [25], '6B': [27, 28]},
        starts=[23.8, 160.3, 281.5, 457.8, 686.6, 889.5, 1020.1, 1418.9, 1568.1], end=1749.6,
        sizes={'pdf': 1840832, 'mp3': 8748252}),
    '2024': dict(
        answers='3341 234 2414 222431 21435642 1 4361414 24 12',
        starts=[27.1, 169.1, 267.6, 493.0, 720.7, 922.7, 1059.1, 1422.8, 1564.9], end=1746.0,
        sizes={'pdf': 1726049, 'mp3': 8730442}),
    '2023': dict(
        answers='1114 312 4432 244411 14321621 4 2265334 31 12',
        starts=[27.2, 161.3, 252.6, 474.6, 698.3, 912.4, 1064.1, 1425.7, 1567.3], end=1750.2,
        sizes={'pdf': 4923536, 'mp3': 8751112}),
    '2022': dict(
        answers='3221 441 3243 134141 24132523 2 3325444 24 22',
        starts=[27.0, 164.7, 257.5, 477.4, 710.9, 916.9, 1063.1, 1413.0, 1551.6], end=1750.1,
        choices={22: 5, 23: 5, 24: 5, 25: 5},
        sizes={'pdf': 756710, 'mp3': 8750722}),
    '2021': dict(
        answers='2432 213 2411 123412 12341215 2 2125441 33 12',
        starts=[27.1, 166.9, 264.7, 478.6, 710.8, 923.6, 1055.7, 1425.4, 1575.2], end=1748.1,
        choices={22: 5, 23: 5, 24: 5, 25: 5},
        sizes={'pdf': 2330213, 'mp3': 8740712}),
}


def snap(t, onsets, window=2.5):
    """推定した開始位置を、いちばん近い「無音明け」の少し手前に合わせる"""
    if not onsets:
        return t
    best = min(onsets, key=lambda o: abs(o - t))
    return round(best - 0.3, 2) if abs(best - t) <= window else t


def build(onsets_by_year=None):
    out = []
    for yid, y in YEARS.items():
        new = int(yid) >= 2025
        layout = NEW if new else OLD
        pages = y.get('pages', PAGES_OLD)
        ans = [[int(c) for c in grp] for grp in y['answers'].split()]
        onsets = (onsets_by_year or {}).get(yid, [])
        starts = [snap(t, onsets) for t in y['starts']]
        secs = []
        for i, sid in enumerate(SECTIONS):
            nums = list(layout[sid])
            assert len(nums) == len(ans[i]), (yid, sid)
            qs, groups = [], []
            for n, a in zip(nums, ans[i]):
                c = y.get('choices', {}).get(n, 6 if (22 <= n <= 25 or 28 <= n <= 31) else 4)
                assert a <= c, (yid, n)
                if sid == '4A':
                    p = 0 if n <= 21 else 1
                elif sid == '5':
                    p = {27: 3, 32: 4, 33: 5 if new else 4}.get(n, 0)
                else:
                    p = POINTS[sid]
                qs.append({'n': n, 'c': c, 'a': a, 'p': p})
            if sid == '4A':
                groups.append({'qs': [18, 19, 20, 21], 'p': 4})
            if sid == '5':
                groups += [{'qs': [28, 29], 'p': 2}, {'qs': [30, 31], 'p': 2}]
            secs.append({'id': sid, 'label': LABEL[sid], 'pages': pages[sid],
                         'start': starts[i], 'end': starts[i + 1] if i < 8 else y['end'],
                         'qs': qs, 'groups': groups})
        total = sum(q['p'] for s in secs for q in s['qs']) + sum(g['p'] for s in secs for g in s['groups'])
        assert total == 100, (yid, total)
        out.append({'id': yid, 'kind': 'kyotsu', 'label': f'{yid}年 本試', 'short': yid,
                    'sizes': y['sizes'], 'sections': secs})
    return out


def build_center():
    """センター試験（2006〜2019年）。音声と問題画像は listening.tokyo のURLを参照するだけで、
    ファイルそのものはこのリポジトリに入れない。配点は全問2点（25問・50点満点）。"""
    src = json.load(open(os.path.join(os.path.dirname(__file__), 'center.json')))
    out = []
    for code in sorted(src, key=lambda c: (-int(c[:4]), c[4] != 'h')):
        year, kind = code[:4], '本試' if code[4] == 'h' else '追試'
        secs, n = [], 0
        for sid in sorted(src[code], key=int):
            v = src[code][sid]
            answers = [int(c) for c in v['ans']]
            choices = 6 if max(answers) > 4 else 4   # 選択肢が6つある問題を含む大問は6つ表示する
            qs = []
            for a in answers:
                n += 1
                qs.append({'n': n, 'c': choices, 'a': a, 'p': 2})
            secs.append({'id': sid, 'label': f'第{sid}問', 'audio': v['mp3'], 'images': v['imgs'],
                         'page': v['page'], 'qs': qs, 'groups': []})
        assert n == 25, code
        out.append({'id': code, 'kind': 'center', 'label': f'{year}年 {kind}', 'short': f'{year}{kind[0]}',
                    'remote': True, 'sections': secs})
    return out


if __name__ == '__main__':
    onsets = {}
    path = os.path.join(os.path.dirname(__file__), 'onsets.json')
    if os.path.exists(path):
        onsets = json.load(open(path))
    data = build(onsets) + build_center()
    dst = os.path.join(os.path.dirname(__file__), '..', 'data.js')
    with open(dst, 'w') as f:
        f.write('// tools/build_data.py が生成したファイル。直接編集しない。\n')
        f.write('window.YEARS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print(len(data), 'exams:', ' '.join(y['short'] for y in data))
