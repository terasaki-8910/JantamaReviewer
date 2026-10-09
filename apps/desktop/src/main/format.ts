const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** 半荘の見出し: 「10月9日(金) 16:12」。今年でなければ年も付ける。 */
export function formatSessionTitle(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`;
  const weekday = WEEKDAYS[d.getDay()] ?? '';
  return `${year}${d.getMonth() + 1}月${d.getDate()}日(${weekday}) ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 迷いマーク・評価の時刻: 「16:14:32」。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** キーの名前を、設定画面に出す短い表記にする（`KeyM` → `M`、`F8` → `F8`）。 */
export function formatKeyCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `テンキー ${code.slice(6)}`;
  const numpad: Record<string, string> = {
    NumpadAdd: '+',
    NumpadSubtract: '-',
    NumpadMultiply: '*',
    NumpadDivide: '/',
    NumpadDecimal: '.',
  };
  const mapped = numpad[code];
  if (mapped) return `テンキー ${mapped}`;
  return code;
}
