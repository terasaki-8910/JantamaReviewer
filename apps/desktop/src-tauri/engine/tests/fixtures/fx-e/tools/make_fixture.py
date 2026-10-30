"""Reference values for the engine's tests, from one S42 self-play game (no personal data).

Run in the sister project's WSL venv (read-only use) with cwd = vendor/Mortal/mortal (for model.py) and
PYTHONPATH there (for libriichi.so):
  python make_fixture.py <game.json.gz> <s42-inference.pth> <out dir>
Writes: game.json (report-like: player_id + mjai_log), obs_v3.npy (moments x 934 x 34, not for the repo),
moments.json (per moment: event index, sha256 of the v3/v4 observation bytes, legal mask, S42 Q values,
each opponent's true waits), cf_obs_v3.npy and cf.json (counterfactual rows for one riichi moment).
"""
import gzip
import hashlib
import json
import sys

import numpy as np
import torch
from libriichi.state import PlayerState
from model import Brain, DQN

TILES = [f'{n}{s}' for s in 'mps' for n in range(1, 10)] + list('ESWNPFC')
SEAT = 0


def kind(pai):
    return TILES.index(pai[:2] if pai.endswith('r') else pai)


def sets_only(counts):
    c = list(counts)
    for i in range(34):
        while c[i] > 0:
            if c[i] >= 3:
                c[i] -= 3
            elif i < 27 and i % 9 <= 6 and c[i + 1] > 0 and c[i + 2] > 0:
                c[i] -= 1
                c[i + 1] -= 1
                c[i + 2] -= 1
            else:
                return False
    return True


def is_agari(counts):
    total = sum(counts)
    if total % 3 != 2:
        return False
    if total == 14:
        if sum(1 for c in counts if c == 2) == 7:
            return True
        terminals = [0, 8, 9, 17, 18, 26] + list(range(27, 34))
        if all(counts[i] >= 1 for i in terminals) and sum(counts[i] for i in terminals) == 14:
            return True
    for p in range(34):
        if counts[p] >= 2:
            counts[p] -= 2
            ok = sets_only(counts)
            counts[p] += 2
            if ok:
                return True
    return False


def waits_of(hand):
    counts = [0] * 34
    for k in hand:
        counts[k] += 1
    out = []
    for t in range(34):
        if counts[t] >= 4:
            continue
        counts[t] += 1
        if is_agari(counts):
            out.append(TILES[t])
        counts[t] -= 1
    return out


def sha(arr):
    return hashlib.sha256(np.ascontiguousarray(arr, dtype='<f4').tobytes()).hexdigest()


def encode_at(log, stop, version):
    state = PlayerState(SEAT)
    for event in log[:stop + 1]:
        state.update(json.dumps(event))
    obs, mask = state.encode_obs(version, False)
    return np.asarray(obs, dtype=np.float32), np.asarray(mask, dtype=bool)


def main(game_path, weights_path, out):
    log = [json.loads(line) for line in gzip.open(game_path, 'rt', encoding='utf-8') if line.strip()]
    json.dump({'player_id': SEAT, 'mjai_log': log}, open(f'{out}/game.json', 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    state = torch.load(weights_path, map_location='cpu', weights_only=True)
    brain = Brain(version=4, conv_channels=192, num_blocks=40).eval()
    dqn = DQN(version=4).eval()
    brain.load_state_dict(state['mortal'])
    dqn.load_state_dict(state['current_dqn'])

    player = PlayerState(SEAT)
    hands = [[] for _ in range(4)]
    riichi = [False] * 4
    moments, v3_rows = [], []
    for index, event in enumerate(log):
        t = event['type']
        player.update(json.dumps(event))
        if t == 'start_kyoku':
            hands = [[kind(p) for p in h] for h in event['tehais']]
            riichi = [False] * 4
        elif t == 'tsumo':
            hands[event['actor']].append(kind(event['pai']))
            if event['actor'] == SEAT:
                v3, mask3 = player.encode_obs(3, False)
                v4, mask4 = player.encode_obs(4, False)
                v3 = np.asarray(v3, dtype=np.float32)
                v4 = np.asarray(v4, dtype=np.float32)
                mask4 = np.asarray(mask4, dtype=bool)
                with torch.no_grad():
                    q = dqn(brain(torch.from_numpy(v4)[None]), torch.from_numpy(mask4)[None])[0].numpy()
                v3_rows.append(v3)
                moments.append({
                    'event_index': index,
                    'v3_shape': list(v3.shape),
                    'v3_sha256': sha(v3),
                    'v4_shape': list(v4.shape),
                    'v4_sha256': sha(v4),
                    'mask': ''.join('1' if m else '0' for m in mask4),
                    'q': [None if not np.isfinite(x) else round(float(x), 6) for x in q],
                    'opponent_riichi': [riichi[(SEAT + s) % 4] for s in (1, 2, 3)],
                    'true_waits': [waits_of(hands[(SEAT + s) % 4]) if len(hands[(SEAT + s) % 4]) % 3 == 1 else []
                                   for s in (1, 2, 3)],
                })
        elif t == 'dahai':
            hands[event['actor']].remove(kind(event['pai']))
        elif t in ('chi', 'pon', 'daiminkan', 'ankan'):
            for p in event['consumed']:
                hands[event['actor']].remove(kind(p))
        elif t == 'kakan':
            hands[event['actor']].remove(kind(event['pai']))
        elif t == 'reach_accepted':
            riichi[event['actor']] = True
    np.save(f'{out}/obs_v3.npy', np.stack(v3_rows))

    # Counterfactual rows for the first moment where an opponent is in riichi: swap each of that
    # opponent's discards (not called ones) in the kyoku for the honor with the fewest visible copies.
    pick = next((i for i, m in enumerate(moments) if any(m['opponent_riichi'])), None)
    cf = {'moment': pick, 'rows': []}
    cf_rows = []
    if pick is not None:
        stop = moments[pick]['event_index']
        step = 1 + moments[pick]['opponent_riichi'].index(True)
        target = (SEAT + step) % 4
        start = max(i for i in range(stop + 1) if log[i]['type'] == 'start_kyoku')
        called = {i - 1 for i in range(start, stop + 1) if log[i]['type'] in ('chi', 'pon', 'daiminkan')}
        visible = {}
        for p in log[start]['tehais'][SEAT]:
            visible[kind(p)] = visible.get(kind(p), 0) + 1
        for e in log[start:stop + 1]:
            if e['type'] == 'tsumo' and e['actor'] != SEAT:
                continue
            for p in [e.get('pai')] + e.get('consumed', []) + ([e['dora_marker']] if 'dora_marker' in e else []):
                if p and p != '?':
                    visible[kind(p)] = visible.get(kind(p), 0) + 1
        filler = min('ESWNPFC', key=lambda h: (visible.get(kind(h), 0), 'ESWNPFC'.index(h)))
        cf['target_step'] = step
        cf['filler'] = filler
        turn = 0
        for i in range(start, stop + 1):
            e = log[i]
            if e['type'] == 'dahai' and e['actor'] == target:
                turn += 1
                if i in called or e['pai'] == filler:
                    continue
                changed = [dict(x) for x in log]
                changed[i]['pai'] = filler
                v3, _ = encode_at(changed, stop, 3)
                cf_rows.append(v3)
                cf['rows'].append({'turn': turn, 'event_index': i, 'pai': e['pai'], 'v3_sha256': sha(v3)})
    np.save(f'{out}/cf_obs_v3.npy', np.stack(cf_rows) if cf_rows else np.zeros((0, 934, 34), np.float32))
    json.dump({'seat': SEAT, 'source': game_path.split('/')[-1], 'moments': moments, 'counterfactual': cf},
              open(f'{out}/moments.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{len(moments)} moments, counterfactual rows {len(cf_rows)} at moment {pick}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
