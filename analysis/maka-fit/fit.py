import csv, math, itertools, warnings
import numpy as np
from scipy.stats import spearmanr
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import Ridge
warnings.filterwarnings('ignore')
rows = list(csv.DictReader(open('dataset.csv', encoding='utf-8')))
def f(r, k):
    v = r[k]
    return float(v) if v not in ('', 'None') else np.nan
y = np.array([float(r['y']) for r in rows]); games = np.array([r['game'] for r in rows])
G = sorted(set(games))
cands = ['match', 'ratio', 'ratio_min', 'logr', 'pa', 'mm', 'rating', 'qloss_sum', 'qloss_mean', 'qloss_max', 'bad1', 'bad5', 'bad10', 'bad20', 'miss', 'n', 'delta', 'ratio_dahai', 'qloss_dahai', 'bad5_dahai']
X = {k: np.array([f(r, k) for r in rows]) for k in cands}
X['bad5_rate'] = X['bad5'] / X['n']; X['miss_rate'] = X['miss'] / X['n']; X['qloss_sum_sqrt'] = np.sqrt(X['qloss_sum'])
X['dphi'] = np.array([(f(r, 'phi_next') - f(r, 'phi_start')) if r['phi_next'] not in ('', 'None') else np.nan for r in rows])
print('== Spearman with MAKA grade (all 67) ==')
for k in sorted(X, key=lambda k: -abs(np.nan_to_num(spearmanr(X[k], y, nan_policy='omit')[0]))):
    rho, p = spearmanr(X[k], y, nan_policy='omit')
    print(f'{k:16s} rho={rho:+.2f} p={p:.3f}')

def metrics(pred):
    pr = np.clip(np.floor(pred + 0.5), 0, 13)
    return dict(mae=np.mean(np.abs(pr - y)), exact=np.mean(pr == y), within1=np.mean(np.abs(pr - y) <= 1), within2=np.mean(np.abs(pr - y) <= 2), rho=spearmanr(pred, y)[0])

def logo_iso(feat, increasing):
    pred = np.zeros_like(y)
    for g in G:
        tr = games != g; te = games == g
        m = IsotonicRegression(increasing=increasing, out_of_bounds='clip').fit(X[feat][tr], y[tr])
        pred[te] = m.predict(X[feat][te])
    return pred

print('\n== Leave-one-game-out: constant baseline ==')
base = np.zeros_like(y)
for g in G: base[games == g] = np.median(y[games != g])
print({k: round(v, 3) for k, v in metrics(base).items()})
print('\n== LOGO isotonic, single feature ==')
res = []
for k in ['match', 'ratio', 'logr', 'pa', 'mm', 'rating', 'qloss_sum', 'qloss_mean', 'bad5', 'bad10', 'bad20', 'bad5_rate', 'miss', 'miss_rate', 'qloss_sum_sqrt', 'ratio_min']:
    inc = spearmanr(X[k], y)[0] > 0
    m = metrics(logo_iso(k, inc)); res.append((m['mae'], k, m))
for mae, k, m in sorted(res):
    print(f'{k:16s} ' + ' '.join(f'{a}={b:.3f}' for a, b in m.items()))

print('\n== LOGO ridge + isotonic calibration on combos ==')
def logo_ridge(feats, alpha=1.0):
    pred = np.zeros_like(y)
    for g in G:
        tr = games != g; te = games == g
        A = np.column_stack([X[k] for k in feats]); mu = A[tr].mean(0); sd = A[tr].std(0) + 1e-9
        Z = (A - mu) / sd
        r = Ridge(alpha=alpha).fit(Z[tr], y[tr]); s = r.predict(Z)
        iso = IsotonicRegression(out_of_bounds='clip').fit(s[tr], y[tr])
        pred[te] = iso.predict(s[te])
    return pred
base_feats = ['ratio', 'logr', 'rating', 'qloss_sum', 'bad5', 'bad10', 'bad20', 'miss', 'n', 'match', 'qloss_max']
best = []
for size in (1, 2, 3):
    for combo in itertools.combinations(base_feats, size):
        m = metrics(logo_ridge(list(combo), alpha=3.0)); best.append((m['mae'], combo, m))
for mae, combo, m in sorted(best)[:12]:
    print(f'{"+".join(combo):34s} ' + ' '.join(f'{a}={b:.3f}' for a, b in m.items()))

print('\n== Does outcome matter beyond play? (partial rank correlation) ==')
from scipy.stats import rankdata
def partial(a, b, c):
    ra, rb, rc = rankdata(a), rankdata(b), rankdata(c)
    def resid(u, v):
        A = np.column_stack([np.ones_like(v), v]); coef = np.linalg.lstsq(A, u, rcond=None)[0]; return u - A @ coef
    return np.corrcoef(resid(ra, rc), resid(rb, rc))[0, 1]
for ctl in ['logr', 'qloss_sum', 'rating', 'ratio']:
    print(f'MAKA vs delta | {ctl}: {partial(y, X["delta"], X[ctl]):+.2f}')
    mask = ~np.isnan(X['dphi'])
    print(f'MAKA vs dphi  | {ctl}: {partial(y[mask], X["dphi"][mask], X[ctl][mask]):+.2f}')
