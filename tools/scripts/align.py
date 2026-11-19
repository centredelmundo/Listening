"""台本の各セリフを、単語タイミング付きの文字起こしと照合して、開始・終了秒を求める。"""
import re
from difflib import SequenceMatcher
from collections import Counter

NUMS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen',
        'fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty']
def norm(w):
    w = w.lower().replace('’', "'").replace('‘', "'")
    w = re.sub(r"[^a-z0-9']", '', w).strip("'")
    if w in NUMS: return str(NUMS.index(w))
    return w
def toks(text):
    text = re.sub(r'(\d),(\d)', r'\1\2', text)
    return [t for t in (norm(x) for x in re.split(r"[\s\-–—―－/]+", text)) if t]

def align(lines, words, t0=0.0, t1=1e9, window=900):
    """lines: [{'text':..}], words: [[start,end,word],...]（時刻順）。lines に 's','e' を書き込む。"""
    rec = [(s, e, norm(w)) for s, e, w in words if t0 - 1 <= s <= t1 + 1]
    rec = [r for r in rec if r[2]]
    rt = [r[2] for r in rec]
    ptr = 0; ok = 0
    for ln in lines:
        lt = toks(ln['text'])
        if not lt or ptr >= len(rt):
            continue
        need = Counter(lt); L = len(lt)
        best = (0, None)
        hi = min(len(rt), ptr + window)
        # まず語の重なりで候補位置を粗く選ぶ
        for st in range(ptr, max(ptr + 1, hi - 1)):
            win = rt[st:st + L + 2]
            if not win or win[0] not in need and (len(win) < 2 or win[1] not in need):
                continue
            sc = sum((Counter(win) & need).values())
            if sc > best[0]:
                best = (sc, st)
                if sc == L: break
        if best[1] is None or best[0] < max(2, 0.5 * L):
            continue
        st = best[1]
        # 細かく合わせる：前後に少し広げて、一致した最初と最後の語を使う
        a0 = max(ptr, st - 3); a1 = min(len(rt), st + L + 6)
        sm = SequenceMatcher(None, lt, rt[a0:a1], autojunk=False)
        blocks = [b for b in sm.get_matching_blocks() if b.size]
        matched = sum(b.size for b in blocks)
        if not blocks or matched < max(2, 0.5 * L):
            continue
        first = a0 + blocks[0].b; last = a0 + blocks[-1].b + blocks[-1].size - 1
        # 台本の先頭・末尾の語が認識されていない場合は、その分だけ前後を広げる
        lead = blocks[0].a; tail = L - (blocks[-1].a + blocks[-1].size)
        first = max(ptr, first - lead); last = min(len(rec) - 1, last + tail)
        ln['s'] = round(rec[first][0], 2); ln['e'] = round(rec[last][1], 2)
        ln['m'] = round(matched / L, 2)
        ptr = last + 1; ok += 1
    return ok
