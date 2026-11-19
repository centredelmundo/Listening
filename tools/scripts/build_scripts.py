#!/usr/bin/env python3
"""scripts.json（ディクテーション用のセリフと再生区間）を作る。

使い方: build_scripts.py <台本HTMLのフォルダ> <文字起こしJSONのフォルダ>
  台本HTML : 共通テストは k{年}h_{大問}.html、センター試験は p{回}_{大問}.html（kyotsutest.jp の各ページ）
  文字起こし: faster-whisper の単語タイミング [[開始,終了,単語],...]。
              共通テストは年度ごとの音声1本、センター試験は {回}_{大問}.mp3.json
"""
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))
from parse import parse
from align import align

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
KYOTSU_AUDIO = {'2022': '5bc45553-2022listening.mp3', '2023': '3d32a2cc-2023listening.mp3'}


def fill_gaps(lines):
    """位置が分からなかったセリフは、前後のセリフの間を再生区間にする"""
    for i, l in enumerate(lines):
        if 's' in l:
            continue
        prev = next((x for x in reversed(lines[:i]) if 'e' in x), None)
        nxt = next((x for x in lines[i + 1:] if 's' in x), None)
        if prev and nxt and 0 < nxt['s'] - prev['e'] < 40:
            l['s'], l['e'] = prev['e'], nxt['s']


def main(html_dir, words_dir):
    data = json.loads(open(os.path.join(ROOT, 'data.js')).read().split('window.YEARS = ')[1].rstrip(';\n'))
    out, total, timed = {}, 0, 0
    for y in data:
        for sec in y['sections']:
            if not sec.get('page'):
                continue
            if y['kind'] == 'kyotsu':
                if y['id'] not in KYOTSU_AUDIO:
                    continue
                qn = [q['n'] for q in sec['qs']]
                src = parse(open(os.path.join(html_dir, f"k{y['id']}h_{sec['id'][0]}.html"), encoding='utf-8', errors='ignore').read())
                lines = [dict(l) for l in src if min(qn) <= l['q'] <= max(qn)]
                words = json.load(open(os.path.join(words_dir, KYOTSU_AUDIO[y['id']] + '.json')))
                align(lines, words, sec['start'], sec['end'])
            else:
                src = parse(open(os.path.join(html_dir, f"p{y['id']}_{sec['id']}.html"), encoding='utf-8', errors='ignore').read())
                lines = [dict(l) for l in src]
                align(lines, json.load(open(os.path.join(words_dir, f"{y['id']}_{sec['id']}.mp3.json"))))
            fill_gaps(lines)
            for l in lines:
                l.pop('m', None)
            if lines:
                out[f"{y['id']}|{sec['id']}"] = lines
                total += len(lines); timed += sum('s' in l for l in lines)
    with open(os.path.join(ROOT, 'scripts.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out)} sections, {total} lines, {timed} with audio range ({timed / total:.1%})')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
