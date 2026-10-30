"""Add tenpai.onnx outputs (onnxruntime, CPU) to the engine fixture.

usage: uv run --with onnxruntime --with numpy python make_reads_ref.py <fixture-out dir> <tenpai.onnx>
Writes reads_ref.json: per moment tenpai[3], waits[3][34], any_wait[34], furiten[3]; and the same for the
counterfactual rows (6 decimals).
"""
import json
import sys

import numpy as np
import onnxruntime as ort


def run(session, obs):
    tenpai, waits, any_wait, furiten = session.run(['tenpai', 'waits', 'any_wait', 'furiten'], {'obs': obs})
    r = lambda a: np.round(a.astype(np.float64), 6).tolist()
    return [{'tenpai': r(tenpai[i]), 'waits': r(waits[i]), 'any_wait': r(any_wait[i]), 'furiten': r(furiten[i])}
            for i in range(len(obs))]


def main(directory, model):
    session = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
    out = {
        'model_sha256': '50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea',
        'moments': run(session, np.load(f'{directory}/obs_v3.npy')),
        'counterfactual': run(session, np.load(f'{directory}/cf_obs_v3.npy')),
    }
    json.dump(out, open(f'{directory}/reads_ref.json', 'w', encoding='utf-8'), separators=(',', ':'))
    print(len(out['moments']), len(out['counterfactual']))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
