import type { ReactNode } from 'react';

/** 出題の画面が、まだ出せないとき（読み込み中・見つからない・空）の本文。見出しと 1 つの知らせ。 */
export function StudyNotice({ title, children, alert = false }: { title: string; children: ReactNode; alert?: boolean }) {
  return (
    <>
      <header className="head qhead">
        <div className="q-main">
          <div className="q-l">
            <h1 className="title">{title}</h1>
          </div>
        </div>
      </header>
      <div className="page">
        <p className="empty" role={alert ? 'alert' : undefined}>
          {children}
        </p>
      </div>
    </>
  );
}
