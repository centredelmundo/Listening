"""台本ページ(HTML)から、セリフ単位の行を取り出す。"""
import re, html, json, sys

SPK = re.compile(r"^([A-Z][A-Za-z.]{0,14}(?: [A-Z][A-Za-z.]{0,14})?)\s*[:：]\s*(.+)$")
QHEAD = re.compile(r"^Questions?\s*(?:No\.?|number)?\s*(\d+)", re.I)
JP = re.compile(r"[ぁ-んァ-ヶ一-龥]")

def lines_of(page):
    # 台本の範囲：「台本」の見出し〜「解答」の見出し
    a = page.find('台本')
    if a < 0:                                   # 見出しがないページは音声の直後から
        a = page.find('wp-audio-shortcode')
        if a < 0:
            return []
    b = page.find('解答', a)
    seg = page[a:b if b > a else None]
    seg = re.sub(r'<(script|style|audio).*?</\1>', '', seg, flags=re.S)
    seg = re.sub(r'<br\s*/?>|</p>|<p[^>]*>|<hr[^>]*>|</h\d>|</div>', '\n', seg)
    seg = html.unescape(re.sub(r'<[^>]+>', '', seg))
    out = []
    for l in seg.split('\n'):
        l = l.replace('　', ' ').replace('\xa0', ' ').replace('ﬂ', 'fl').replace('ﬁ', 'fi')
        l = re.sub(r'\s+', ' ', l).strip()
        l = re.sub(r'^[\uFF00-\uFFEF【】\s]+|[\uFF00-\uFFEF【】\s]+$', '', l)   # 「Ａ」「【」などの飾り
        if l:
            out.append(l)
    return out

def chunk(text, limit=28):
    """長い発話は、文の切れ目で limit 語程度ずつに分ける"""
    sents = re.split(r'(?<=[.!?])\s+(?=[A-Z“"‘\'(])', text)
    out, cur = [], []
    for s in sents:
        n = len(s.split())
        if cur and len(' '.join(cur).split()) + n > limit:
            out.append(' '.join(cur)); cur = []
        cur.append(s)
    if cur:
        out.append(' '.join(cur))
    return out

def parse(page):
    q = None; turns = []
    for l in lines_of(page):
        if JP.search(l):
            continue
        m = QHEAD.match(l)
        if m:
            q = int(m.group(1)); rest = l[m.end():].lstrip(' .:').strip()
            # 「Questions No. 27 to 32」などの残りは捨てる。同じ行に本文が続く場合だけ拾う
            rest = re.sub(r'^(?:to|and|-|〜|～)\s*\d+\s*', '', rest).strip()
            if not rest or re.fullmatch(r'[\d\s.,]*', rest):
                continue
            l = rest
            # 「W： ... M： ...」が1行に続けて書かれている場合は話者ごとに分ける
            if len(re.findall(r'\b[MW]\s*[:：]', l)) > 1:
                for part in re.split(r'(?=\b[MW]\s*[:：])', l):
                    part = part.strip()
                    m = SPK.match(part)
                    if m: turns.append({'q': q, 'spk': m.group(1), 'text': m.group(2).strip()})
                continue
        if re.fullmatch(r'(?:Question|Listen again)\W*', l, re.I) or q is None:
            continue
        # 第4問Bの「① Hi there! ... ② Hello!」は、①②…が話者
        if re.search(r'[①-⑨]', l):
            parts = re.split(r'([①-⑨])', l)
            if parts[0].strip() and turns and turns[-1]['q'] == q:
                turns[-1]['text'] += ' ' + parts[0].strip()
            for i in range(1, len(parts), 2):
                if parts[i + 1].strip():
                    turns.append({'q': q, 'spk': parts[i], 'text': parts[i + 1].strip()})
            continue
        # 共通テスト第2問などで読み上げられる「Question：〜」は独立した行にする
        mq = re.search(r'\bQuestion\s*[:：]\s*(.+)$', l)
        if mq and not l.startswith('Question'):
            head = l[:mq.start()].strip()
            if head:
                m = SPK.match(head)
                if m:
                    turns.append({'q': q, 'spk': m.group(1), 'text': m.group(2).strip()})
                elif turns and turns[-1]['q'] == q:
                    turns[-1]['text'] += ' ' + head
            turns.append({'q': q, 'spk': 'Question', 'text': mq.group(1).strip()})
            continue
        if l.startswith('Question') and re.match(r'^Question\s*[:：]\s*(.+)$', l):
            turns.append({'q': q, 'spk': 'Question', 'text': re.match(r'^Question\s*[:：]\s*(.+)$', l).group(1)})
            continue
        m = SPK.match(l)
        if m and m.group(1).lower() not in ('question', 'note'):
            turns.append({'q': q, 'spk': m.group(1), 'text': m.group(2).strip()})
        elif turns and turns[-1]['q'] == q:
            turns[-1]['text'] += ' ' + l            # 話者名のない行は直前の発話の続き
        else:
            turns.append({'q': q, 'spk': '', 'text': l})
    out = []
    for t in turns:
        if re.match(r'^Question\b', t['text']) and t['spk'] == '':
            continue
        for c in chunk(t['text']):
            out.append({'q': t['q'], 'spk': t['spk'], 'text': c})
    return out

if __name__ == '__main__':
    for f in sys.argv[1:]:
        r = parse(open(f, encoding='utf-8', errors='ignore').read())
        print('=====', f, len(r))
        for x in r[:60]:
            print(f"  q{x['q']:>2} {x['spk'][:6]:>6} | {x['text'][:90]}")
