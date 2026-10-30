//! `read` コマンドの本体: 牌譜の自分の手番の場面ごとに、他家の読みを出して reads.json に書く（F23）。
//!
//! 流れ:
//! 1. 牌譜を読み（`report`）、出力先のフォルダがあるか確かめ、頭から再生して場面を集める（`replay`）。
//!    libriichi が断る牌譜は、ここでエラーになる。
//! 2. モデルを読む（`model`）。ここまでのエラーは、進み具合を出す前に終わる（標準エラーは日本語の 1 行だけ）。
//! 3. 場面を `CHUNK` ずつ取り、観測（v3）を組み立てて推論する。リーチした他家と、聴牌の確率が 50% 以上の他家には、
//!    その局の捨て牌を 1 枚ずつ字牌に替えた観測も推論し、手牌の牌ごとに確率を大きく動かした捨て牌を探す（`counterfactual`）。
//! 4. 結果を reads.json に書く。エンジンが書くファイルは、これだけ。
//!
//! 確率は小数 4 桁に丸めて書く。牌の名前は mjai の書き方（赤牌は元の種類）。

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use anyhow::{bail, Context, Result};
use ndarray::Array2;
use riichi::state::PlayerState;
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde::Serialize as SerializeDerive;

use crate::args::ReadArgs;
use crate::counterfactual::{self, Swap};
use crate::model::{Outputs, TenpaiModel};
use crate::replay::{collect_moments, opponent_seat, Moment};
use crate::report::{load_report, Report};
use crate::tiles::{kind_name, kind_of, KINDS};

/// 出力の形の名前。
pub const FORMAT: &str = "jantama-reads/1";
/// 読み直すのは、聴牌の確率がこれ以上の他家（リーチした他家は、確率によらず読み直す）。
pub const REREAD_TENPAI: f32 = 0.5;
/// 効いた捨て牌として出す、確率の動きの下限。
pub const MIN_MOVE: f64 = 0.01;
/// 手牌の牌ごとに出す、効いた捨て牌の数の上限。
pub const MAX_REASONS: usize = 2;
/// 読みの上位として出す牌の数。
pub const TOP_WAITS: usize = 5;
/// 一度に処理する場面の数。進み具合は、この単位で出す。
const CHUNK: usize = 32;

// ---- 出力の形（reads.json） ----

#[derive(Debug, SerializeDerive)]
pub struct Reads {
    pub format: &'static str,
    pub model: ModelInfo,
    pub player_id: u8,
    pub moments: Vec<MomentReads>,
}

#[derive(Debug, SerializeDerive)]
pub struct ModelInfo {
    pub file: String,
    pub sha256: String,
}

#[derive(Debug, SerializeDerive)]
pub struct MomentReads {
    pub event_index: usize,
    pub kyoku_index: usize,
    pub bakaze: &'static str,
    pub kyoku: u8,
    pub honba: u8,
    pub junme: usize,
    pub hand: Vec<&'static str>,
    pub any_wait: Vec<f64>,
    pub opponents: Vec<OpponentReads>,
}

#[derive(Debug, SerializeDerive)]
pub struct OpponentReads {
    pub seat: u8,
    pub step: u8,
    pub riichi: bool,
    pub tenpai: f64,
    pub furiten: f64,
    pub waits: Vec<f64>,
    pub top_waits: Vec<TopWait>,
    pub actual_waits: Vec<&'static str>,
    pub reasons: Reasons,
}

#[derive(Debug, SerializeDerive)]
pub struct TopWait {
    pub tile: &'static str,
    pub p: f64,
}

#[derive(Debug, Clone, PartialEq, SerializeDerive)]
pub struct Reason {
    pub turn: usize,
    pub event_index: usize,
    pub pai: &'static str,
    pub without: f64,
}

/// 手牌の牌 → 効いた捨て牌。キーは牌の順（34 種の番号の順）に並べて書く。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Reasons(pub Vec<(&'static str, Vec<Reason>)>);

impl Serialize for Reasons {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (tile, reasons) in &self.0 {
            map.serialize_entry(tile, reasons)?;
        }
        map.end()
    }
}

/// 小数 4 桁に丸める。
pub fn round4(value: f32) -> f64 {
    // `+ 0.0` は、-0.0 を 0.0 にそろえる。
    (f64::from(value) * 10_000.0).round() / 10_000.0 + 0.0
}

// ---- 入口 ----

/// `read` コマンド。`progress(done, total)` は、場面の処理が進むたびに呼ぶ。
pub fn run_read(args: &ReadArgs, progress: &mut dyn FnMut(usize, usize)) -> Result<()> {
    let report = load_report(&args.report, args.player)?;
    check_output_folder(&args.out)?;
    let moments = collect_moments(&report)?;
    let model = TenpaiModel::load(&args.model)?;
    let reads = build_reads(&report, &moments, &model, progress)?;
    write_reads(&args.out, &reads)
}

/// 出力先のフォルダがあるか、計算を始める前に確かめる（長い計算のあとで書けないと分かるのを避ける）。
fn check_output_folder(out: &Path) -> Result<()> {
    let folder = match out.parent() {
        Some(folder) if !folder.as_os_str().is_empty() => folder,
        _ => Path::new("."),
    };
    if !folder.is_dir() {
        bail!("出力先のフォルダがありません: {}", folder.display());
    }
    Ok(())
}

/// reads.json の内容を作る。
pub fn build_reads(
    report: &Report,
    moments: &[Moment],
    model: &TenpaiModel,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<Reads> {
    let total = moments.len();
    progress(0, total);
    let mut reads = Vec::with_capacity(total);
    for chunk in moments.chunks(CHUNK) {
        let observations: Vec<Array2<f32>> = chunk.iter().map(|m| observation(&m.state)).collect();
        let base = model.run(&observations)?;
        let moved = reread(report, chunk, &base, model)?;
        for ((moment, outputs), moved) in chunk.iter().zip(&base).zip(moved) {
            reads.push(moment_reads(report.player_id, moment, outputs, moved));
        }
        progress(reads.len(), total);
    }
    Ok(Reads {
        format: FORMAT,
        model: ModelInfo {
            file: model.file_name().to_string(),
            sha256: model.sha256().to_string(),
        },
        player_id: report.player_id,
        moments: reads,
    })
}

/// reads.json を書く。エンジンが書くファイルは、これだけ。
pub fn write_reads(path: &Path, reads: &Reads) -> Result<()> {
    let file =
        File::create(path).with_context(|| format!("出力先に書けません: {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, reads)
        .with_context(|| format!("出力先に書けません: {}", path.display()))?;
    writer
        .flush()
        .with_context(|| format!("出力先に書けません: {}", path.display()))
}

// ---- 観測 ----

/// モデルに渡す観測（v3、934×34）。
pub fn observation(state: &PlayerState) -> Array2<f32> {
    state.encode_obs(3, false).0
}

// ---- 場面ごとの組み立て ----

fn moment_reads(
    player: u8,
    moment: &Moment,
    outputs: &Outputs,
    reasons: [Reasons; 3],
) -> MomentReads {
    let opponents = reasons
        .into_iter()
        .enumerate()
        .map(|(index, reasons)| {
            let step = index + 1;
            let waits = &outputs.waits[index];
            OpponentReads {
                seat: opponent_seat(player, step),
                step: step as u8,
                riichi: moment.riichi[index],
                tenpai: round4(outputs.tenpai[index]),
                furiten: round4(outputs.furiten[index]),
                waits: waits.iter().copied().map(round4).collect(),
                top_waits: top_waits(waits),
                actual_waits: moment.actual_waits[index]
                    .iter()
                    .map(|&kind| kind_name(kind))
                    .collect(),
                reasons,
            }
        })
        .collect();
    MomentReads {
        event_index: moment.event_index,
        kyoku_index: moment.kyoku_index,
        bakaze: kind_of(moment.bakaze).map_or("E", kind_name),
        kyoku: moment.kyoku,
        honba: moment.honba,
        junme: moment.junme,
        hand: moment.hand.iter().map(|&kind| kind_name(kind)).collect(),
        any_wait: outputs.any_wait.iter().copied().map(round4).collect(),
        opponents,
    }
}

/// 確率の高い順に `TOP_WAITS` 牌（同じ確率なら番号の小さい牌が先）。
pub fn top_waits(waits: &[f32; KINDS]) -> Vec<TopWait> {
    let mut order: Vec<usize> = (0..KINDS).collect();
    order.sort_by(|&a, &b| waits[b].total_cmp(&waits[a]));
    order
        .into_iter()
        .take(TOP_WAITS)
        .map(|kind| TopWait {
            tile: kind_name(kind),
            p: round4(waits[kind]),
        })
        .collect()
}

// ---- 効いた捨て牌 ----

/// 1 人の他家について、捨て牌を 1 つ替えて取り直した「待ち」の確率。
struct Rerun {
    swap: Swap,
    waits: [f32; KINDS],
}

/// 場面ごと・他家ごとに、効いた捨て牌を探す。読み直さない他家の分は、空。
fn reread(
    report: &Report,
    moments: &[Moment],
    base: &[Outputs],
    model: &TenpaiModel,
) -> Result<Vec<[Reasons; 3]>> {
    let player = report.player_id;
    let mut reruns: Vec<[Vec<Rerun>; 3]> = moments.iter().map(|_| Default::default()).collect();

    // 替えた観測は、64 場面ぶん（`BATCH`）たまるたびに推論する（全部を持つと大きすぎる）。
    let mut queue = Queue::default();
    for (index, (moment, outputs)) in moments.iter().zip(base).enumerate() {
        for step in 1..=3 {
            if !(moment.riichi[step - 1] || outputs.tenpai[step - 1] >= REREAD_TENPAI) {
                continue;
            }
            let target = opponent_seat(player, step);
            let plan = counterfactual::plan(
                &report.events,
                player,
                moment.kyoku_start,
                moment.event_index,
                target,
            );
            for swap in plan.swaps {
                // 替えた牌譜を libriichi が断ったら、その捨て牌は飛ばす（元の牌譜は、ここまでに通っている）。
                let Ok(state) = counterfactual::swapped_state(
                    &report.events,
                    player,
                    moment.kyoku_start,
                    moment.event_index,
                    &swap,
                    plan.filler,
                ) else {
                    continue;
                };
                queue.push(observation(&state), (index, step - 1, swap));
                if queue.is_full() {
                    queue.flush(model, &mut reruns)?;
                }
            }
        }
    }
    queue.flush(model, &mut reruns)?;

    Ok(moments
        .iter()
        .zip(base)
        .zip(reruns)
        .map(|((moment, outputs), per_opponent)| {
            let mut reasons: [Reasons; 3] = Default::default();
            for (index, reruns) in per_opponent.iter().enumerate() {
                reasons[index] = reasons_for(moment, &outputs.waits[index], reruns);
            }
            reasons
        })
        .collect())
}

/// 替えた観測のたまり場。
#[derive(Default)]
struct Queue {
    observations: Vec<Array2<f32>>,
    tags: Vec<(usize, usize, Swap)>,
}

impl Queue {
    fn push(&mut self, observation: Array2<f32>, tag: (usize, usize, Swap)) {
        self.observations.push(observation);
        self.tags.push(tag);
    }

    fn is_full(&self) -> bool {
        self.observations.len() >= crate::model::BATCH
    }

    /// たまった観測を推論して、結果を場面・他家ごとの置き場に移す。
    fn flush(&mut self, model: &TenpaiModel, reruns: &mut [[Vec<Rerun>; 3]]) -> Result<()> {
        if self.observations.is_empty() {
            return Ok(());
        }
        let outputs = model.run(&self.observations)?;
        for ((moment, opponent, swap), outputs) in self.tags.drain(..).zip(outputs) {
            reruns[moment][opponent].push(Rerun {
                swap,
                waits: outputs.waits[opponent],
            });
        }
        self.observations.clear();
        Ok(())
    }
}

/// 手牌の牌ごとに、確率をいちばん大きく動かした捨て牌を `MAX_REASONS` つまで選ぶ。
/// 動きは「元の読み − 替えた読み」の絶対値で、`MIN_MOVE` 未満の動きは出さない。同じ大きさなら、先の捨て牌が先。
fn reasons_for(moment: &Moment, base_waits: &[f32; KINDS], reruns: &[Rerun]) -> Reasons {
    let mut entries = Vec::new();
    for &kind in &moment.hand {
        let mut movers: Vec<(f64, &Rerun)> = reruns
            .iter()
            .filter_map(|rerun| {
                let moved = (f64::from(base_waits[kind]) - f64::from(rerun.waits[kind])).abs();
                (moved >= MIN_MOVE).then_some((moved, rerun))
            })
            .collect();
        // 並べ替えは安定なので、同じ大きさなら捨て牌の順のまま。
        movers.sort_by(|a, b| b.0.total_cmp(&a.0));
        movers.truncate(MAX_REASONS);
        if movers.is_empty() {
            continue;
        }
        let reasons = movers
            .into_iter()
            .map(|(_, rerun)| Reason {
                turn: rerun.swap.turn,
                event_index: rerun.swap.event_index,
                pai: kind_of(rerun.swap.pai).map_or("?", kind_name),
                without: round4(rerun.waits[kind]),
            })
            .collect();
        entries.push((kind_name(kind), reasons));
    }
    Reasons(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_to_four_decimals_without_negative_zero() {
        assert_eq!(round4(0.123_449_99), 0.1234);
        assert_eq!(round4(0.123_45), 0.1235);
        assert_eq!(round4(1.0), 1.0);
        assert!(round4(-0.000_001).is_sign_positive());
        assert_eq!(round4(0.000_04), 0.0);
    }

    #[test]
    fn top_waits_sort_by_probability_then_by_tile_order() {
        let mut waits = [0.0f32; KINDS];
        waits[3] = 0.5;
        waits[20] = 0.5;
        waits[33] = 0.9;
        waits[1] = 0.2;
        waits[12] = 0.1;
        waits[30] = 0.05;
        let top = top_waits(&waits);
        let names: Vec<&str> = top.iter().map(|t| t.tile).collect();
        assert_eq!(names, ["C", "4m", "3s", "2m", "4p"]);
        assert_eq!(top[0].p, 0.9);
    }

    #[test]
    fn reasons_serialize_as_an_ordered_object() {
        let reasons = Reasons(vec![
            (
                "9m",
                vec![Reason {
                    turn: 2,
                    event_index: 7,
                    pai: "5p",
                    without: 0.1,
                }],
            ),
            ("E", vec![]),
        ]);
        let text = serde_json::to_string(&reasons).unwrap();
        assert_eq!(
            text,
            r#"{"9m":[{"turn":2,"event_index":7,"pai":"5p","without":0.1}],"E":[]}"#
        );
    }
}
