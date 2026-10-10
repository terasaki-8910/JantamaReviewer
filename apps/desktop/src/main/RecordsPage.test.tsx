import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { installTauriMock } from '../../tests/tauri-mock';
import type { SessionRecord } from '../api/types';
import { RecordsPage } from './RecordsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

const newest: SessionRecord = {
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
};

const older: SessionRecord = {
  id: '20261008-210000',
  started_ms: local(2026, 10, 8, 21, 0),
  mark_count: 0,
  rating_count: 0,
  marks: [],
  ratings: [],
  events: [],
  report_path: null,
  ocr: null,
  links: { marks: {}, ratings: {} },
};

describe('記録ページ', () => {
  it('半荘を新しい順に、日時と迷い・評価の数つきで一覧にする', async () => {
    installTauriMock({ sessions: [newest, older] });
    render(<RecordsPage />);
    const nav = await screen.findByRole('navigation', { name: '半荘の一覧' });
    const rows = within(nav).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('10月9日(金) 16:12');
    expect(rows[0]).toHaveTextContent('迷い 2');
    expect(rows[0]).toHaveTextContent('評価 3');
    expect(rows[1]).toHaveTextContent('10月8日(木) 21:00');
    expect(rows[1]).toHaveTextContent('迷い 0');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');
  });

  it('選んだ半荘の迷いマークを、サムネイルと時刻で出す', async () => {
    installTauriMock({ sessions: [newest, older] });
    render(<RecordsPage />);
    const detail = await screen.findByRole('region', { name: /10月9日/ });
    const thumbs = within(detail).getAllByRole('img', { name: /のスクリーンショット/ });
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]).toHaveAttribute(
      'src',
      `asset://localhost/${encodeURIComponent('C:\\data\\games\\20261009-161200\\marks\\a.png')}`,
    );
    expect(thumbs[0]).toHaveAccessibleName('迷い 1 のスクリーンショット（16:14:32）');
    expect(within(detail).getByText('16:14:32')).toBeInTheDocument();
    // 画像を撮れなかった迷いも、時刻つきで残る。
    expect(within(detail).getByText('16:20:05')).toBeInTheDocument();
    expect(within(detail).getByText('画像なし')).toBeInTheDocument();
  });

  it('評価を押した順に、何局目かと〇△✕で出す', async () => {
    installTauriMock({ sessions: [newest] });
    render(<RecordsPage />);
    const detail = await screen.findByRole('region', { name: /10月9日/ });
    const list = within(detail).getByRole('list', { name: '局の評価の一覧' });
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

  it('別の半荘を選ぶと、中身が切り替わる。空の半荘は短い文で示す', async () => {
    installTauriMock({ sessions: [newest, older] });
    const user = userEvent.setup();
    render(<RecordsPage />);
    await screen.findByRole('region', { name: /10月9日/ });
    await user.click(screen.getByRole('button', { name: /10月8日/ }));
    const detail = await screen.findByRole('region', { name: /10月8日/ });
    expect(within(detail).getByText('迷いの記録はありません。')).toBeInTheDocument();
    expect(within(detail).getByText('評価はまだありません。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /10月8日/ })).toHaveAttribute('aria-current', 'true');
  });

  it('記録が無いときは、ウィジェットの操作を案内する短い文だけを出す', async () => {
    installTauriMock({ sessions: [] });
    render(<RecordsPage />);
    expect(await screen.findByText(/まだ記録がありません/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '半荘の一覧' })).toBeNull();
  });

  it('state-changed のイベントで、一覧を読み直す', async () => {
    const mock = installTauriMock({ sessions: [older] });
    render(<RecordsPage />);
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    expect(mock.count('list_sessions')).toBe(1);
    act(() => mock.emit('state-changed', {}));
    await waitFor(() => expect(mock.count('list_sessions')).toBe(2));
  });

  it('一覧を読めなかったら、理由を出す', async () => {
    installTauriMock({
      handlers: {
        list_sessions: () => {
          throw '保存先を開けませんでした';
        },
      },
    });
    render(<RecordsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('保存先を開けませんでした');
  });
});
