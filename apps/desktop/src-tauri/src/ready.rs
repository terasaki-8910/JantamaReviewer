//! 窓を見せる時機（N-7）。
//!
//! 窓は隠したまま作る。画面（webview）が最初の絵を描き終えて知らせて（`window_ready`）から見せるので、
//! 描き終える前の白い面が見えない。
//! - ウィジェットは、画面が知らせたら見せる。
//! - 検討画面は、見せてほしいという要求（メニュー・`--show-main`）があって、画面も知らせたら見せる。
//!   どちらが先でもよい。
//! - 画面が知らせて来なくても、窓が見えないままにならないよう、一定の時間が過ぎたら（`timeout`）見せる。
//!
//! ここは「いま見せるか」を決める純粋な部分。実際に窓を見せるのは `commands.rs`。

use std::collections::HashSet;

#[derive(Debug, Default)]
pub struct ShowGate {
    /// 画面が知らせたら、要求が無くても見せる窓。
    auto_show: HashSet<String>,
    ready: HashSet<String>,
    wanted: HashSet<String>,
    shown: HashSet<String>,
}

impl ShowGate {
    pub fn new(auto_show: &[&str]) -> ShowGate {
        ShowGate {
            auto_show: auto_show.iter().map(|s| (*s).to_string()).collect(),
            ..ShowGate::default()
        }
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.ready.contains(label)
    }

    /// 画面が最初の絵を描き終えた。いま窓を見せるなら `true`。
    pub fn mark_ready(&mut self, label: &str) -> bool {
        self.ready.insert(label.to_string());
        self.show_if_wanted(label)
    }

    /// 窓を見せてほしいという要求（メニューなど）。いま窓を見せるなら `true`。
    /// 画面がまだ知らせていなければ `false`（知らせた時に見せる）。見せたあとの要求は、何度でも `true`。
    pub fn request_show(&mut self, label: &str) -> bool {
        self.wanted.insert(label.to_string());
        if self.ready.contains(label) {
            self.shown.insert(label.to_string());
            true
        } else {
            false
        }
    }

    /// 一定の時間が過ぎた。見せるべき窓なのにまだ見せていなければ `true`（画面からの知らせを待たずに見せる）。
    pub fn timeout(&mut self, label: &str) -> bool {
        self.show_if_wanted(label)
    }

    fn show_if_wanted(&mut self, label: &str) -> bool {
        let should = self.auto_show.contains(label) || self.wanted.contains(label);
        if should && !self.shown.contains(label) {
            self.shown.insert(label.to_string());
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDGET: &str = "widget";
    const MAIN: &str = "main";

    fn gate() -> ShowGate {
        ShowGate::new(&[WIDGET])
    }

    #[test]
    fn n7_the_widget_is_shown_only_after_its_screen_reports_ready() {
        let mut g = gate();
        assert!(!g.is_ready(WIDGET));
        assert!(g.mark_ready(WIDGET), "知らせが届いたら見せる");
        assert!(g.is_ready(WIDGET));
    }

    #[test]
    fn n7_the_widget_is_shown_once_even_if_ready_is_reported_twice() {
        let mut g = gate();
        assert!(g.mark_ready(WIDGET));
        assert!(
            !g.mark_ready(WIDGET),
            "StrictMode の二重の効果で 2 回届いても、2 度は見せない"
        );
    }

    #[test]
    fn n7_the_main_window_stays_hidden_until_it_is_both_ready_and_requested() {
        let mut g = gate();
        // 要求が無いまま、画面が知らせた: 見せない（起動時は隠したまま）。
        assert!(!g.mark_ready(MAIN));
        // その後に要求: すぐ見せる。
        assert!(g.request_show(MAIN));
    }

    #[test]
    fn n7_a_request_before_ready_shows_the_window_when_the_screen_reports() {
        let mut g = gate();
        assert!(!g.request_show(MAIN), "画面がまだなので見せない");
        assert!(g.mark_ready(MAIN), "知らせが届いたら見せる");
    }

    #[test]
    fn n7_repeated_requests_always_show_again() {
        let mut g = gate();
        g.mark_ready(MAIN);
        assert!(g.request_show(MAIN));
        assert!(
            g.request_show(MAIN),
            "一度見せたあとでも、見せる要求には何度でも応える"
        );
        assert!(g.request_show(MAIN));
    }

    #[test]
    fn n7_the_timeout_shows_the_widget_even_without_a_ready_report() {
        let mut g = gate();
        assert!(
            g.timeout(WIDGET),
            "知らせが無くても、窓が見えないままにしない"
        );
        assert!(!g.timeout(WIDGET), "見せたあとは何もしない");
        assert!(
            !g.mark_ready(WIDGET),
            "あとから知らせが届いても、見せ直さない"
        );
    }

    #[test]
    fn n7_the_timeout_does_not_show_an_unrequested_main_window() {
        let mut g = gate();
        assert!(!g.timeout(MAIN));
        g.request_show(MAIN);
        assert!(
            g.timeout(MAIN),
            "要求があるのに、知らせが無いままなら見せる"
        );
    }
}
