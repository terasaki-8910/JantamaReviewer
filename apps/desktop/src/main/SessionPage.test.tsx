import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FX4_TEXT } from '../../tests/import-fixtures';
import type { SessionRecord } from '../api/types';
import { SessionPage } from './SessionPage';
import { summarizeReportText, type SummaryState } from './sessionSummaries';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

const recorded: SessionRecord = {
  id: '20261009-161200',
  started_ms: local(2026, 10, 9, 16, 12),
  mark_count: 2,
  rating_count: 3,
  marks: [
    {
      id: 1,
      t_ms: local(2026, 10, 9, 16, 14, 32),
      screenshot: 'marks/a.png',
      capture: 'window',
      capture_error: null,
      screenshot_path: 'C:\\data\\games\\20261009-161200\\marks\\a.png',
    },
    {
      id: 3,
      t_ms: local(2026, 10, 9, 16, 20, 5),
      screenshot: null,
      capture: null,
      capture_error: '画面を撮れませんでした',
      screenshot_path: null,
    },
  ],
  ratings: [
    { id: 2, t_ms: local(2026, 10, 9, 16, 15, 0), rating: 'good', hand: 1 },
    { id: 4, t_ms: local(2026, 10, 9, 16, 22, 0), rating: 'bad', hand: 2 },
    { id: 5, t_ms: local(2026, 10, 9, 16, 30, 0), rating: 'fair', hand: 3 },
  ],
  events: [],
  report_path: null,
  ocr: null,
  links: { marks: {}, ratings: {} },
  self_ratings: { kyokus: {} },
  maka: { kyokus: {} },
};

const empty: SessionRecord = {
  ...recorded,
  id: '20261008-210000',
  started_ms: local(2026, 10, 8, 21, 0),
  mark_count: 0,
  rating_count: 0,
  marks: [],
  ratings: [],
};

const imported: SessionRecord = { ...recorded, report_path: 'C:\\data\\games\\20261009-161200\\report.json' };

describe('U-8: 半荘のページ（記録のページの中身を、そのまま出す）', () => {
  it('見出しは 日時（取り込み前は、そのまま）。取り込み前は「取り込み前」と、迷いと評価の数を添える。段階の印は出さない', () => {
    render(<SessionPage session={recorded} summary={undefined} />);
    expect(screen.getByRole('heading', { level: 1, name: '10月9日(金) 16:12' })).toBeInTheDocument();
    expect(screen.getByText('取り込み前 · 迷い 2 · 評価 3')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
    expect(screen.getByRole('region', { name: /10月9日/ })).toBeInTheDocument();
  });

  it('取り込み済みは、見出しに卓、右に段階の印（大）と Rating。「5局 · 東3局1本場で終了」', () => {
    const summary = summarizeReportText(FX4_TEXT);
    expect(summary.status).toBe('ready');
    render(<SessionPage session={imported} summary={summary} />);
    expect(screen.getByRole('heading', { level: 1, name: '10月9日(金) 16:12 · 玉の間・南' })).toBeInTheDocument();
    expect(screen.getByText('5局 · 東3局1本場で終了')).toBeInTheDocument();
    const badge = document.querySelector('.grade.lg');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(summary.status === 'ready' ? summary.summary.grade : '');
    expect(screen.getByText('93.0')).toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeInTheDocument();
  });

  it('結果を読んでいる間は、迷いと評価の数。読めなかったときは、理由を添える。どちらも段階の印は出さない', () => {
    const loading: SummaryState = { status: 'loading' };
    const { unmount } = render(<SessionPage session={imported} summary={loading} />);
    expect(screen.getByText('迷い 2 · 評価 3')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
    unmount();
    render(<SessionPage session={imported} summary={{ status: 'unavailable', reason: '形が合いません' }} />);
    expect(screen.getByText('取り込んだ結果を読めませんでした（形が合いません）')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
  });

  it('迷いマークを、サムネイルと時刻で出す。画像を撮れなかった迷いも、時刻つきで残す', () => {
    render(<SessionPage session={recorded} summary={undefined} />);
    expect(screen.getByRole('heading', { level: 2, name: '迷い（2）' })).toBeInTheDocument();
    const detail = screen.getByRole('region', { name: /10月9日/ });
    const thumbs = within(detail).getAllByRole('img', { name: /のスクリーンショット/ });
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]).toHaveAttribute(
      'src',
      `asset://localhost/${encodeURIComponent('C:\\data\\games\\20261009-161200\\marks\\a.png')}`,
    );
    expect(thumbs[0]).toHaveAccessibleName('迷い 1 のスクリーンショット（16:14:32）');
    expect(within(detail).getByText('16:14:32')).toBeInTheDocument();
    expect(within(detail).getByText('16:20:05')).toBeInTheDocument();
    expect(within(detail).getByText('画像なし')).toBeInTheDocument();
  });

  it('評価を押した順に、何局目かと〇△✕で出す', () => {
    render(<SessionPage session={recorded} summary={undefined} />);
    expect(screen.getByRole('heading', { level: 2, name: '評価（3）' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '局の評価の一覧' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('1局目');
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: '〇' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('2局目');
    expect(within(rows[1] as HTMLElement).getByRole('img', { name: '✕' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('3局目');
    expect(within(rows[2] as HTMLElement).getByRole('img', { name: '△' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('16:15:00');
  });

  it('空の半荘は、短い文で示す', () => {
    render(<SessionPage session={empty} summary={undefined} />);
    expect(screen.getByText('迷いの記録はありません。')).toBeInTheDocument();
    expect(screen.getByText('評価はまだありません。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '10月8日(木) 21:00' })).toBeInTheDocument();
  });
});
