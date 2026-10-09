/** 成功か失敗かを値で返す型。ライブラリの関数は、読み込みの失敗を例外にせず、理由つきでこの型で返す。 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
