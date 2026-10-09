"""Build a per-hand dataset: Mortal review features + MAKA grade."""
import json, math, csv
import os
D = os.path.join(os.environ.get('JANTAMA_DATA', os.path.join(os.path.expanduser('~'), 'JantamaReviewerData')), 'reports') + os.sep
GRADES = ['D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'S-', 'S', 'S+']
GAMES = {
    'f9da87cbcd7af5e9': 'C-,S,A-,S+,C+,C+,S,S,S,S,S,S',
    'f738896995c33fed': 'S+,A,A+,C,S-,S,A+,S+,S,S+,S+,S+,s',
    'be0a2a523fdd7758': 'S+,B,B,S,s+,s,a-,a-,a+,s-,s-',
    '002ca97adccc486d': 'c+,s+,s-,s+,s+,a+,s+,s+,b-,s+,s,s+,a+,s,a-,s-',
    '3a36dac7c7fc18ce': 'b-,s-,s,a-,s+,c+,a,a+,s,a-,s+,a+,a-,s+,a',
}
NAMES = ['東1', '東2', '東3', '東4', '南1', '南2', '南3', '南4', '西1', '西2', '西3', '西4']
CALL_TYPES = {'chi', 'pon', 'daiminkan', 'none'}

def kind(e):
    types = {d['action']['type'] for d in e['details']}
    if 'hora' in types: return 'agari'
    if 'reach' in types: return 'riichi'
    if types & {'chi', 'pon', 'daiminkan'}: return 'call'
    if 'ankan' in types or 'kakan' in types: return 'kan'
    return 'dahai'

rows = []
for gid, gs in GAMES.items():
    d = json.load(open(D + gid + '.json', encoding='utf-8'))
    me = d['player_id']
    grades = [g.strip().upper() for g in gs.split(',')]
    ks = d['review']['kyokus']
    assert len(grades) == len(ks), gid
    phi = d['review']['relative_phi_matrix']
    for i, (k, g) in enumerate(zip(ks, grades)):
        es = k['entries']
        feats = dict(game=gid, idx=i, label=NAMES[k['kyoku']] + '局' + (f"{k['honba']}本場" if k['honba'] else ''), grade=g, y=GRADES.index(g))
        n = len(es); feats['n'] = n
        ratios, logr, pas, mms, qloss, match = [], [], [], [], [], []
        per_kind = {}
        for e in es:
            det = e['details']; a = e['actual_index']
            pa = det[a]['prob']; ptop = max(x['prob'] for x in det)
            qs = [x['q_value'] for x in det]; qa = det[a]['q_value']; qtop = max(qs); qmin = min(qs)
            r = pa / ptop if ptop > 0 else 0.0
            mm = 1.0 if e['is_equal'] else (qa - qmin) / max(qtop - qmin, 1e-6)
            ratios.append(r); logr.append(math.log(max(r, 1e-4))); pas.append(pa); mms.append(mm); qloss.append(qtop - qa); match.append(1 if e['is_equal'] else 0)
            kd = kind(e); per_kind.setdefault(kd, []).append((r, qtop - qa, pa))
        feats.update(
            match=sum(match) / n, ratio=sum(ratios) / n, ratio_min=min(ratios), logr=sum(logr) / n, pa=sum(pas) / n,
            mm=sum(mms) / n, rating=(sum(mms) / n) ** 2,
            qloss_sum=sum(qloss), qloss_mean=sum(qloss) / n, qloss_max=max(qloss),
            bad1=sum(1 for p in pas if p < 0.01), bad5=sum(1 for p in pas if p < 0.05), bad10=sum(1 for p in pas if p < 0.10), bad20=sum(1 for p in pas if p < 0.20),
            miss=n - sum(match),
        )
        for kd in ('dahai', 'call', 'riichi', 'agari', 'kan'):
            v = per_kind.get(kd, [])
            feats['n_' + kd] = len(v)
            feats['ratio_' + kd] = (sum(x[0] for x in v) / len(v)) if v else None
            feats['qloss_' + kd] = sum(x[1] for x in v) if v else 0.0
            feats['bad5_' + kd] = sum(1 for x in v if x[2] < 0.05)
        # outcome for the reviewed player
        st = k['end_status'][0] if k['end_status'] else {}
        deltas = st.get('deltas') or [0, 0, 0, 0]
        feats['delta'] = deltas[me]
        if st.get('type') == 'hora':
            feats['outcome'] = 'win' if st['actor'] == me else ('dealin' if st.get('target') == me else ('tsumo_other' if st['actor'] == st.get('target') else 'other_ron'))
        else:
            feats['outcome'] = 'ryukyoku'
        # Mortal's expected pt change across the hand (luck + play), from the phi matrix
        def pt(m):
            return sum(p * w for p, w in zip(m[me] if isinstance(m[0], list) else m, [90, 45, 0, -135]))
        try:
            feats['phi_start'] = sum(p * w for p, w in zip(phi[i][0], [90, 45, 0, -135]))
            feats['phi_next'] = sum(p * w for p, w in zip(phi[i + 1][0], [90, 45, 0, -135])) if i + 1 < len(phi) else None
        except Exception:
            feats['phi_start'] = None; feats['phi_next'] = None
        rows.append(feats)

keys = list(rows[0].keys())
for r in rows:
    for k2 in r:
        if k2 not in keys: keys.append(k2)
with open('dataset.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
print(len(rows), 'hands;', 'grade counts:', {g: sum(1 for r in rows if r['grade'] == g) for g in GRADES})
