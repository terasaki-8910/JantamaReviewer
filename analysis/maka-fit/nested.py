import csv, itertools, warnings
import numpy as np
from scipy.stats import spearmanr
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import Ridge
warnings.filterwarnings('ignore')
rows = list(csv.DictReader(open('dataset.csv', encoding='utf-8')))
f = lambda r, k: float(r[k]) if r[k] not in ('', 'None') else np.nan
y = np.array([float(r['y']) for r in rows]); games = np.array([r['game'] for r in rows]); G = sorted(set(games))
feat_names = ['ratio', 'logr', 'rating', 'qloss_sum', 'qloss_mean', 'bad5', 'bad10', 'bad20', 'miss', 'match', 'n', 'qloss_max', 'pa']
X = {k: np.array([f(r, k) for r in rows]) for k in feat_names}
def fit_predict(feats, tr, te, alpha):
    A = np.column_stack([X[k] for k in feats]); mu = A[tr].mean(0); sd = A[tr].std(0) + 1e-9; Z = (A - mu) / sd
    r = Ridge(alpha=alpha).fit(Z[tr], y[tr]); s = r.predict(Z)
    iso = IsotonicRegression(out_of_bounds='clip').fit(s[tr], y[tr])
    return iso.predict(s[te]), r.coef_, mu, sd
def score(pred, yy):
    pr = np.clip(np.rint(pred), 0, 12)
    return np.mean(np.abs(pr - yy)), np.mean(pr == yy), np.mean(np.abs(pr - yy) <= 1)
# 1) honest estimate of "search the best 1-3 feature combo" via nested LOGO
combos = [c for s in (1, 2, 3) for c in itertools.combinations(['ratio', 'logr', 'rating', 'qloss_sum', 'bad5', 'bad10', 'bad20', 'miss', 'n', 'match', 'qloss_max'], s)]
pred = np.zeros_like(y); chosen = []
for g in G:
    outer_tr = games != g; te = games == g
    inner_games = [h for h in G if h != g]
    best = None
    for c in combos:
        p = np.zeros_like(y); m = outer_tr.copy()
        for h in inner_games:
            itr = outer_tr & (games != h); ite = games == h
            p[ite] = fit_predict(list(c), itr, ite, 3.0)[0]
        mae = np.mean(np.abs(np.clip(np.rint(p[outer_tr]), 0, 12) - y[outer_tr]))
        if best is None or mae < best[0]: best = (mae, c)
    chosen.append(best[1])
    pred[te] = fit_predict(list(best[1]), outer_tr, te, 3.0)[0]
mae, ex, w1 = score(pred, y)
print(f'nested combo search: MAE={mae:.3f} exact={ex:.3f} within1={w1:.3f} rho={spearmanr(pred, y)[0]:.3f}; chosen per fold: {chosen}')
# 2) fixed full feature set ridge (no selection), several alphas
for alpha in (1, 3, 10, 30):
    p = np.zeros_like(y)
    for g in G:
        tr = games != g; te = games == g
        p[te] = fit_predict(feat_names, tr, te, alpha)[0]
    mae, ex, w1 = score(p, y)
    print(f'ridge(all {len(feat_names)} feats, alpha={alpha}): MAE={mae:.3f} exact={ex:.3f} within1={w1:.3f} rho={spearmanr(p, y)[0]:.3f}')
# 3) principled two-part score: ratio + qloss_sum (fixed, no search)
for feats in (['ratio', 'qloss_sum'], ['rating', 'qloss_sum'], ['ratio', 'bad10'], ['ratio'], ['rating']):
    p = np.zeros_like(y)
    for g in G:
        tr = games != g; te = games == g
        p[te] = fit_predict(feats, tr, te, 3.0)[0]
    mae, ex, w1 = score(p, y)
    print(f'fixed {"+".join(feats):18s}: MAE={mae:.3f} exact={ex:.3f} within1={w1:.3f} rho={spearmanr(p, y)[0]:.3f}')
# 4) full-data coefficients of ratio+qloss_sum for interpretation
A = np.column_stack([X['ratio'], X['qloss_sum']]); mu = A.mean(0); sd = A.std(0); Z = (A - mu) / sd
r = Ridge(alpha=3.0).fit(Z, y); print('ratio+qloss_sum standardized coef:', np.round(r.coef_, 2), 'intercept', round(r.intercept_, 2), 'mu', np.round(mu, 3), 'sd', np.round(sd, 3))
# 5) per-game bias check
for g in G:
    m = games == g
    print(g, 'n_hands', m.sum(), 'mean MAKA', round(y[m].mean(), 2), 'mean ratio', round(X['ratio'][m].mean(), 3), 'mean rating', round(X['rating'][m].mean(), 3))
