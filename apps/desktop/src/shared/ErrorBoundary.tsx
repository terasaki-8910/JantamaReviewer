import { Component, Fragment, useEffect, type ErrorInfo, type ReactNode } from 'react';

import { signalWindowReady } from './windowReady';

interface ErrorScreenProps {
  /** 同じ内容をもう一度描き直す。ブラウザの再読み込みはしない。 */
  onRetry: () => void;
  /** ウィジェットのような小さい窓向けの短い文言と配置。 */
  compact?: boolean;
}

/**
 * 画面の描画に失敗したときの、アプリの中のエラー画面（N-5）。
 * ブラウザのエラーページは出さない。短い日本語と、描き直すボタンだけ。
 * 窓は最初の絵を描いてから見せるので、ここでも「描き終えた」と知らせて、窓が見えないままにならないようにする。
 */
export function ErrorScreen({ onRetry, compact = false }: ErrorScreenProps) {
  useEffect(() => {
    void signalWindowReady();
  }, []);

  return (
    <main className={compact ? 'error-screen compact' : 'error-screen'} role="alert">
      <h1 className="error-title">{compact ? '表示エラー' : '表示できませんでした'}</h1>
      {!compact && <p className="error-text">画面を描いている途中で、問題が起きました。</p>}
      <button type="button" className="error-retry" onClick={onRetry}>
        {compact ? '再表示' : 'もう一度表示する'}
      </button>
    </main>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  compact?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** 描き直した回数。子の部品を作り直す（状態を持ち越さない）ための鍵。 */
  attempt: number;
}

/**
 * 子の部品の描画で例外が出たら、エラー画面に替える。「もう一度表示する」で、子の部品を最初から作り直す。
 * どちらの窓も、いちばん外側に置く。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('画面を描けませんでした', error, info.componentStack);
  }

  private retry = () => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorScreen compact={this.props.compact} onRetry={this.retry} />;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
