//! 固定データ FX-E（ACCEPTANCE の E-52〜E-55）による、エンジンの部品の試験。
//!
//! - E-52 観測: v3・v4 の観測と合法手の印が、Python の libriichi と、126 場面すべてでビット単位で一致する。
//! - E-55 実際の待ち: 牌譜の全員の手牌から数えた待ちが、固定データの答えと一致する。
//! - E-54 効いた捨て牌（準備）: 替える牌（filler）と、替える捨て牌の一覧と、替えた観測の sha256 が一致する。
//! - E-53 読みの推論: tract の出力が onnxruntime の値と 1e-4 以内で一致する（モデルがあるときだけ）。
//!
//! E-52・E-55・E-54 はモデルが要らず、いつも動く。

mod common;

use std::collections::HashMap;

use jantama_engine::counterfactual::{self, kyoku_start};
use jantama_engine::model::{Outputs, TenpaiModel};
use jantama_engine::reads::observation;
use jantama_engine::replay::{collect_moments, opponent_seat};
use jantama_engine::tiles::KIND_NAMES;
use riichi::state::PlayerState;
use serde_json::Value;

use common::{load_game, mask_string, obs_sha256, reference_moments};

/// 参照の場面の、`event_index`。
fn event_index(moment: &Value) -> usize {
    moment["event_index"].as_u64().expect("event_index") as usize
}

#[test]
fn e52_observations_and_masks_match_python_libriichi_bit_for_bit() {
    let report = load_game();
    let references: HashMap<usize, Value> = reference_moments()
        .into_iter()
        .map(|moment| (event_index(&moment), moment))
        .collect();
    assert_eq!(references.len(), 126);

    let mut state = PlayerState::new(report.player_id);
    let mut checked = 0;
    for (index, event) in report.events.iter().enumerate() {
        state.update(event).expect("固定データの牌譜は通る");
        let Some(reference) = references.get(&index) else {
            continue;
        };
        let (v3, mask3) = state.encode_obs(3, false);
        let (v4, mask4) = state.encode_obs(4, false);
        assert_eq!(v3.dim(), (934, 34), "event {index}");
        assert_eq!(v4.dim(), (1012, 34), "event {index}");
        assert_eq!(
            obs_sha256(&v3),
            reference["v3_sha256"].as_str().unwrap(),
            "v3 の観測が違う: event {index}"
        );
        assert_eq!(
            obs_sha256(&v4),
            reference["v4_sha256"].as_str().unwrap(),
            "v4 の観測が違う: event {index}"
        );
        let mask = reference["mask"].as_str().unwrap();
        assert_eq!(
            mask_string(&mask4),
            mask,
            "合法手の印が違う（v4）: event {index}"
        );
        assert_eq!(
            mask_string(&mask3),
            mask,
            "合法手の印が違う（v3）: event {index}"
        );
        checked += 1;
    }
    assert_eq!(checked, 126);
}

#[test]
fn e55_actual_waits_match_the_fixture_for_every_moment() {
    let report = load_game();
    let moments = collect_moments(&report).expect("固定データの牌譜から場面を集められる");
    let ours: HashMap<usize, _> = moments.iter().map(|m| (m.event_index, m)).collect();

    let references = reference_moments();
    for reference in &references {
        let index = event_index(reference);
        let moment = ours
            .get(&index)
            .unwrap_or_else(|| panic!("場面 {index} が見つからない"));
        for step in 0..3 {
            let expected: Vec<&str> = reference["true_waits"][step]
                .as_array()
                .expect("true_waits")
                .iter()
                .map(|tile| tile.as_str().unwrap())
                .collect();
            let actual: Vec<&str> = moment.actual_waits[step]
                .iter()
                .map(|&kind| KIND_NAMES[kind])
                .collect();
            assert_eq!(
                actual,
                expected,
                "実際の待ちが違う: event {index} step {}",
                step + 1
            );
            assert_eq!(
                moment.riichi[step],
                reference["opponent_riichi"][step].as_bool().unwrap(),
                "リーチの印が違う: event {index} step {}",
                step + 1
            );
        }
    }
}

#[test]
fn moments_are_own_draws_plus_own_calls_that_must_discard() {
    let report = load_game();
    let moments = collect_moments(&report).unwrap();
    let reference: Vec<usize> = reference_moments().iter().map(event_index).collect();

    // 参照の 126 場面（自分のツモ）は、すべて含まれ、順番も同じ。
    let draws: Vec<usize> = moments
        .iter()
        .map(|m| m.event_index)
        .filter(|index| reference.contains(index))
        .collect();
    assert_eq!(draws, reference);

    // 足されるのは、自分のチー・ポンの直後だけ（固定データの席 0 は、チー 3 回・ポン 1 回）。
    let extra: Vec<usize> = moments
        .iter()
        .map(|m| m.event_index)
        .filter(|index| !reference.contains(index))
        .collect();
    assert_eq!(extra.len(), 4, "{extra:?}");
    for index in extra {
        let event = serde_json::to_value(&report.events[index]).unwrap();
        let kind = event["type"].as_str().unwrap();
        assert!(kind == "chi" || kind == "pon", "{index}: {kind}");
        assert_eq!(event["actor"], 0);
    }

    // 局の通し番号は 0 から、巡目はその局の自分のツモの回数。
    let mut kyoku = 0usize;
    let mut draws_in_kyoku = 0usize;
    let mut next_moment = moments.iter().peekable();
    for (index, event) in report.events.iter().enumerate() {
        let event = serde_json::to_value(event).unwrap();
        match event["type"].as_str().unwrap() {
            "start_kyoku" => {
                kyoku += 1;
                draws_in_kyoku = 0;
            }
            "tsumo" if event["actor"] == 0 => draws_in_kyoku += 1,
            _ => {}
        }
        if let Some(moment) = next_moment.next_if(|m| m.event_index == index) {
            assert_eq!(moment.kyoku_index + 1, kyoku, "event {index}");
            assert_eq!(moment.junme, draws_in_kyoku, "event {index}");
            assert!(moment.hand.windows(2).all(|w| w[0] < w[1]), "event {index}");
        }
    }
    assert!(next_moment.next().is_none());
}

/// 反実仮想の計画（E-54 の準備）: 場面 17 の、替える牌・替える捨て牌・替えた観測の sha256。
#[test]
fn e54_counterfactual_plan_and_swapped_observations_match_the_fixture() {
    let report = load_game();
    let player = report.player_id;
    let fixture = common::fixture_json("moments.json");
    let reference = &fixture["counterfactual"];
    let pick = reference["moment"].as_u64().unwrap() as usize;
    assert_eq!(pick, 17);
    let stop = event_index(&reference_moments()[pick]);
    let target = opponent_seat(player, reference["target_step"].as_u64().unwrap() as usize);

    let start = kyoku_start(&report.events, stop).expect("局の最初がある");
    let plan = counterfactual::plan(&report.events, player, start, stop, target);
    assert_eq!(
        plan.filler.to_string(),
        reference["filler"].as_str().unwrap()
    );

    let rows = reference["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 9);
    assert_eq!(plan.swaps.len(), rows.len());
    for (swap, row) in plan.swaps.iter().zip(rows) {
        assert_eq!(swap.turn as u64, row["turn"].as_u64().unwrap());
        assert_eq!(
            swap.event_index as u64,
            row["event_index"].as_u64().unwrap()
        );
        assert_eq!(swap.pai.to_string(), row["pai"].as_str().unwrap());

        let state =
            counterfactual::swapped_state(&report.events, player, start, stop, swap, plan.filler)
                .expect("替えた牌譜も通る");
        assert_eq!(
            obs_sha256(&observation(&state)),
            row["v3_sha256"].as_str().unwrap(),
            "替えた観測が違う: turn {}",
            swap.turn
        );
    }
}

/// tract の値と参照の値が 1e-4 以内か確かめ、いちばん大きかった差を返す。
fn assert_close(actual: &[f32], expected: &Value, what: &str) -> f64 {
    let expected: Vec<f64> = expected
        .as_array()
        .unwrap_or_else(|| panic!("{what}: 配列のはず"))
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    assert_eq!(actual.len(), expected.len(), "{what}");
    let mut worst = 0.0f64;
    for (index, (a, e)) in actual.iter().zip(&expected).enumerate() {
        let diff = (f64::from(*a) - e).abs();
        assert!(diff <= 1e-4, "{what}[{index}]: tract {a} / onnxruntime {e}");
        worst = worst.max(diff);
    }
    worst
}

fn assert_outputs_match(outputs: &Outputs, reference: &Value, what: &str) -> f64 {
    let mut worst = assert_close(
        &outputs.tenpai,
        &reference["tenpai"],
        &format!("{what} tenpai"),
    );
    worst = worst.max(assert_close(
        &outputs.any_wait,
        &reference["any_wait"],
        &format!("{what} any_wait"),
    ));
    worst = worst.max(assert_close(
        &outputs.furiten,
        &reference["furiten"],
        &format!("{what} furiten"),
    ));
    for opponent in 0..3 {
        worst = worst.max(assert_close(
            &outputs.waits[opponent],
            &reference["waits"][opponent],
            &format!("{what} waits[{opponent}]"),
        ));
    }
    worst
}

/// E-53: tract の出力が、onnxruntime の値と 1e-4 以内で一致する（126 場面と、反実仮想の 9 行）。
#[test]
fn e53_tract_outputs_match_onnxruntime_within_1e_4() {
    let Some(model_path) = common::model_path() else {
        return;
    };
    let model = TenpaiModel::load(&model_path).expect("モデルを読める");
    assert_eq!(model.sha256(), common::MODEL_SHA256);

    let report = load_game();
    let player = report.player_id;
    let moments = collect_moments(&report).unwrap();
    let ours: HashMap<usize, _> = moments.iter().map(|m| (m.event_index, m)).collect();
    let reference = common::fixture_json("reads_ref.json");
    assert_eq!(reference["model_sha256"], common::MODEL_SHA256);

    // 126 場面
    let moment_refs = reference_moments();
    let observations: Vec<_> = moment_refs
        .iter()
        .map(|r| observation(&ours[&event_index(r)].state))
        .collect();
    let outputs = model.run(&observations).expect("推論できる");
    assert_eq!(outputs.len(), 126);
    let mut worst = 0.0f64;
    for (index, (output, expected)) in outputs
        .iter()
        .zip(reference["moments"].as_array().unwrap())
        .enumerate()
    {
        worst = worst.max(assert_outputs_match(
            output,
            expected,
            &format!("場面 {index}"),
        ));
    }
    let worst_moments = worst;

    // 反実仮想の 9 行
    let fixture = common::fixture_json("moments.json");
    let cf = &fixture["counterfactual"];
    let stop = event_index(&moment_refs[cf["moment"].as_u64().unwrap() as usize]);
    let target = opponent_seat(player, cf["target_step"].as_u64().unwrap() as usize);
    let start = kyoku_start(&report.events, stop).unwrap();
    let plan = counterfactual::plan(&report.events, player, start, stop, target);
    let rows: Vec<_> = plan
        .swaps
        .iter()
        .map(|swap| {
            let state = counterfactual::swapped_state(
                &report.events,
                player,
                start,
                stop,
                swap,
                plan.filler,
            )
            .unwrap();
            observation(&state)
        })
        .collect();
    let outputs = model.run(&rows).expect("推論できる");
    let expected = reference["counterfactual"].as_array().unwrap();
    assert_eq!(outputs.len(), 9);
    assert_eq!(expected.len(), 9);
    let mut worst_rows = 0.0f64;
    for (index, (output, expected)) in outputs.iter().zip(expected).enumerate() {
        worst_rows = worst_rows.max(assert_outputs_match(
            output,
            expected,
            &format!("反実仮想 {index}"),
        ));
    }
    println!(
        "E-53: 126 場面と反実仮想 9 行を tract で推論し、onnxruntime との差は最大 {worst_moments:.2e}・{worst_rows:.2e}（許容 1e-4）"
    );
}
