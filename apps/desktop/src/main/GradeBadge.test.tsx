import { GRADES, type Grade } from '@jantama/engine';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DISPLAY_GRADES, FILLED_GRADES, GradeBadge, isFilledGrade } from './GradeBadge';

describe('U-7: 段階の印（GradeBadge）', () => {
  it('14 段階すべてを、強い順（S+ から E）に持つ。エンジンの段階と同じ名前', () => {
    expect(DISPLAY_GRADES).toEqual(['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'E']);
    expect([...DISPLAY_GRADES].sort()).toEqual([...GRADES].sort());
  });

  it('塗りがあるのは S+〜B- の 9 段だけ。C+〜E は線だけ', () => {
    expect(FILLED_GRADES).toEqual(['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-']);
    for (const grade of DISPLAY_GRADES) {
      expect(isFilledGrade(grade), grade).toBe(FILLED_GRADES.includes(grade));
    }
    expect(DISPLAY_GRADES.filter((g) => !isFilledGrade(g))).toEqual(['C+', 'C', 'C-', 'D', 'E']);
  });

  it('どの段階も、段階の名前を文字にして、data-grade に持つ（色は CSS がトークンから選ぶ）', () => {
    for (const grade of DISPLAY_GRADES) {
      const { unmount } = render(<GradeBadge grade={grade} />);
      const badge = screen.getByText(grade);
      expect(badge).toHaveAttribute('data-grade', grade);
      expect(badge).toHaveClass('grade');
      expect(badge).not.toHaveClass('lg');
      expect(badge).not.toHaveAttribute('style');
      unmount();
    }
  });

  it('大きいほう（lg）は、半荘のページの見出し用', () => {
    render(<GradeBadge grade={'S-' satisfies Grade} size="lg" />);
    expect(screen.getByText('S-')).toHaveClass('grade', 'lg');
  });
});
