import csv, json, itertools, warnings
import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import Ridge
from scipy.stats import spearmanr
warnings.filterwarnings('ignore')
GR = ['E', 'D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'S-', 'S', 'S+']
rows = list(csv.DictReader(open('dataset.csv', encoding='utf-8')))
order = ['f9da87cbcd7af5e9', 'f738896995c33fed', 'be0a2a523fdd7758', '002ca97adccc486d', '3a36dac7c7fc18ce']
y = np.array([float(r['y']) for r in rows]); games = np.array([r['game'] for r in rows]); G = order
rating = np.array([float(r['rating']) * 100 for r in rows]); ratio = np.array([float(r['ratio']) * 100 for r in rows])
def logo_iso(x):
    p = np.zeros_like(y)
    for g in G:
        tr = games != g; te = games == g
        p[te] = IsotonicRegression(out_of_bounds='clip').fit(x[tr], y[tr]).predict(x[te])
    return p
def summary(pred):
    pr = np.clip(np.rint(pred), 0, 13); e = np.abs(pr - y)
    return dict(exact=round(float(np.mean(e == 0)), 3), w1=round(float(np.mean(e <= 1)), 3), w2=round(float(np.mean(e <= 2)), 3), mae=round(float(np.mean(e)), 2))
pr_rating = logo_iso(rating)
# nested combo search again, to get within2 too
X = {k: np.array([float(r[k]) for r in rows]) for k in ['ratio', 'logr', 'rating', 'qloss_sum', 'bad5', 'bad10', 'bad20', 'miss', 'n', 'match', 'qloss_max']}
def fp(feats, tr, te):
    A = np.column_stack([X[k] for k in feats]); mu = A[tr].mean(0); sd = A[tr].std(0) + 1e-9; Z = (A - mu) / sd
    s = Ridge(alpha=3.0).fit(Z[tr], y[tr]).predict(Z)
    return IsotonicRegression(out_of_bounds='clip').fit(s[tr], y[tr]).predict(s[te])
combos = [c for s in (1, 2, 3) for c in itertools.combinations(list(X), s)]
pn = np.zeros_like(y)
for g in G:
    otr = games != g; te = games == g; best = None
    for c in combos:
        p = np.zeros_like(y)
        for h in [h for h in G if h != g]:
            itr = otr & (games != h); ite = games == h; p[ite] = fp(list(c), itr, ite)
        mae = np.mean(np.abs(np.clip(np.rint(p[otr]), 0, 13) - y[otr]))
        if best is None or mae < best[0]: best = (mae, c)
    pn[te] = fp(list(best[1]), otr, te)
base = np.zeros_like(y)
for g in G: base[games == g] = np.median(y[games != g])
res = {'baseline': summary(base), 'match': summary(logo_iso(np.array([float(r['match']) for r in rows]))), 'ratio': summary(logo_iso(ratio)), 'rating': summary(pr_rating), 'auto': summary(pn)}
print(json.dumps(res, ensure_ascii=False))
# isotonic fit on all data for the drawn step line
iso = IsotonicRegression(out_of_bounds='clip').fit(rating, y)
xs = np.linspace(rating.min(), 100, 200); steps = []
prev = None
for x in xs:
    v = int(np.clip(np.rint(iso.predict([x])[0]), 0, 13))
    if v != prev: steps.append([round(float(x), 1), v]); prev = v
pts = [dict(g=order.index(r['game']) + 1, k=r['label'], m=r['grade'], y=int(r['y']), r=round(float(rt), 1), q=round(float(rq), 1), p=GR[int(np.clip(np.rint(pp), 0, 13))]) for r, rt, rq, pp in zip(rows, rating, ratio, pr_rating)]
json.dump(dict(points=pts, steps=steps, results=res), open('chart.json', 'w', encoding='utf-8'), ensure_ascii=False)
print('steps', steps)
print('rating range', rating.min(), rating.max())
