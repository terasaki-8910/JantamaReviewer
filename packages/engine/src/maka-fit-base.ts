/**
 * MAKA の評価への当てはめの、基礎の記録（E-13、F10、U-31）。自動生成のファイル。手で直さない。
 *
 * analysis/maka-fit/dataset.csv（5半荘・67局の Mortal の Rating と MAKA の評価）から、使う列だけを写した定数。
 * `game` は mjai の結果の ID、`idx` は半荘の中の局の順、`label` は局の名前（`kyokuLabel`）、`grade` は MAKA の評価、
 * `rating` は局の Rating（0 から 1。点数はこの 100 倍）。
 *
 * dataset.csv を変えたら、環境変数 UPDATE_MAKA_FIT_BASE=1 を付けて tests/maka-fit-base.test.ts だけを動かすと、このファイルを書き直す。
 * 試験は、dataset.csv を読み直した値と、この定数が完全に一致することを確かめる。
 */
import type { Grade } from './grade';

/** 基礎の記録 1 局分。 */
export interface MakaBaseRecord {
  /** mjai の結果の ID（半荘）。 */
  game: string;
  /** 半荘の中の局の順（0 から）。 */
  idx: number;
  /** 局の名前。例: 東2局1本場。 */
  label: string;
  /** MAKA の評価。 */
  grade: Grade;
  /** 局の Rating（0 から 1）。 */
  rating: number;
}

export const MAKA_BASE_RECORDS: readonly MakaBaseRecord[] = [
  { game: 'f9da87cbcd7af5e9', idx: 0, label: '東1局', grade: 'C-', rating: 0.46842182263312543 },
  { game: 'f9da87cbcd7af5e9', idx: 1, label: '東2局', grade: 'S', rating: 0.9716693488276535 },
  { game: 'f9da87cbcd7af5e9', idx: 2, label: '東2局1本場', grade: 'A-', rating: 0.927572810483245 },
  { game: 'f9da87cbcd7af5e9', idx: 3, label: '東3局', grade: 'S+', rating: 0.9417299657172916 },
  { game: 'f9da87cbcd7af5e9', idx: 4, label: '東3局1本場', grade: 'C+', rating: 0.8795176473869663 },
  { game: 'f9da87cbcd7af5e9', idx: 5, label: '東4局', grade: 'C+', rating: 0.6587157005337662 },
  { game: 'f9da87cbcd7af5e9', idx: 6, label: '東4局1本場', grade: 'S', rating: 0.8188088446500141 },
  { game: 'f9da87cbcd7af5e9', idx: 7, label: '南1局', grade: 'S', rating: 0.951559590773328 },
  { game: 'f9da87cbcd7af5e9', idx: 8, label: '南2局1本場', grade: 'S', rating: 0.9714307824970017 },
  { game: 'f9da87cbcd7af5e9', idx: 9, label: '南3局', grade: 'S', rating: 0.8072762353676963 },
  { game: 'f9da87cbcd7af5e9', idx: 10, label: '南4局', grade: 'S', rating: 0.939113086518066 },
  { game: 'f9da87cbcd7af5e9', idx: 11, label: '西1局', grade: 'S', rating: 0.9315241405531671 },
  { game: 'f738896995c33fed', idx: 0, label: '東1局', grade: 'S+', rating: 1 },
  { game: 'f738896995c33fed', idx: 1, label: '東2局', grade: 'A', rating: 0.7769321307297992 },
  { game: 'f738896995c33fed', idx: 2, label: '東3局', grade: 'A+', rating: 0.8687872304191151 },
  { game: 'f738896995c33fed', idx: 3, label: '東3局1本場', grade: 'C', rating: 0.7587014561426597 },
  { game: 'f738896995c33fed', idx: 4, label: '東3局2本場', grade: 'S-', rating: 0.9456694611458833 },
  { game: 'f738896995c33fed', idx: 5, label: '東3局3本場', grade: 'S', rating: 0.9463627570908459 },
  { game: 'f738896995c33fed', idx: 6, label: '東4局', grade: 'A+', rating: 0.9261453025280207 },
  { game: 'f738896995c33fed', idx: 7, label: '東4局1本場', grade: 'S+', rating: 0.9769741205601965 },
  { game: 'f738896995c33fed', idx: 8, label: '南1局', grade: 'S', rating: 0.91764775680428 },
  { game: 'f738896995c33fed', idx: 9, label: '南1局1本場', grade: 'S+', rating: 0.9529390191233138 },
  { game: 'f738896995c33fed', idx: 10, label: '南2局', grade: 'S+', rating: 0.9092732091167068 },
  { game: 'f738896995c33fed', idx: 11, label: '南3局', grade: 'S+', rating: 0.9844517221562059 },
  { game: 'f738896995c33fed', idx: 12, label: '南4局', grade: 'S', rating: 0.9484221521791947 },
  { game: 'be0a2a523fdd7758', idx: 0, label: '東1局', grade: 'S+', rating: 0.9847672568489404 },
  { game: 'be0a2a523fdd7758', idx: 1, label: '東2局', grade: 'B', rating: 0.6771899983007121 },
  { game: 'be0a2a523fdd7758', idx: 2, label: '東3局', grade: 'B', rating: 0.8728486384432979 },
  { game: 'be0a2a523fdd7758', idx: 3, label: '東4局', grade: 'S', rating: 0.9214920770247756 },
  { game: 'be0a2a523fdd7758', idx: 4, label: '東4局1本場', grade: 'S+', rating: 1 },
  { game: 'be0a2a523fdd7758', idx: 5, label: '東4局2本場', grade: 'S', rating: 1 },
  { game: 'be0a2a523fdd7758', idx: 6, label: '東4局3本場', grade: 'A-', rating: 0.8341193344768509 },
  { game: 'be0a2a523fdd7758', idx: 7, label: '南1局', grade: 'A-', rating: 0.7588911692978088 },
  { game: 'be0a2a523fdd7758', idx: 8, label: '南2局', grade: 'A+', rating: 0.6242092545826008 },
  { game: 'be0a2a523fdd7758', idx: 9, label: '南3局', grade: 'S-', rating: 0.902429234845931 },
  { game: 'be0a2a523fdd7758', idx: 10, label: '南4局', grade: 'S-', rating: 0.8829255069406482 },
  { game: '002ca97adccc486d', idx: 0, label: '東1局', grade: 'C+', rating: 0.6638853350661141 },
  { game: '002ca97adccc486d', idx: 1, label: '東2局', grade: 'S+', rating: 1 },
  { game: '002ca97adccc486d', idx: 2, label: '東2局1本場', grade: 'S-', rating: 0.9716235452500747 },
  { game: '002ca97adccc486d', idx: 3, label: '東2局2本場', grade: 'S+', rating: 1 },
  { game: '002ca97adccc486d', idx: 4, label: '東3局', grade: 'S+', rating: 0.9575619193051779 },
  { game: '002ca97adccc486d', idx: 5, label: '東4局', grade: 'A+', rating: 0.8395193040984905 },
  { game: '002ca97adccc486d', idx: 6, label: '東4局1本場', grade: 'S+', rating: 1 },
  { game: '002ca97adccc486d', idx: 7, label: '南1局', grade: 'S+', rating: 1 },
  { game: '002ca97adccc486d', idx: 8, label: '南2局', grade: 'B-', rating: 0.8897060142201617 },
  { game: '002ca97adccc486d', idx: 9, label: '南3局', grade: 'S+', rating: 0.9204120778613538 },
  { game: '002ca97adccc486d', idx: 10, label: '南3局1本場', grade: 'S', rating: 0.9340631105872343 },
  { game: '002ca97adccc486d', idx: 11, label: '南3局2本場', grade: 'S+', rating: 0.9875665343414858 },
  { game: '002ca97adccc486d', idx: 12, label: '南3局3本場', grade: 'A+', rating: 0.9581844672644647 },
  { game: '002ca97adccc486d', idx: 13, label: '南4局', grade: 'S', rating: 0.9542030816548962 },
  { game: '002ca97adccc486d', idx: 14, label: '南4局1本場', grade: 'A-', rating: 0.836199041319864 },
  { game: '002ca97adccc486d', idx: 15, label: '南4局2本場', grade: 'S-', rating: 0.9526684275054409 },
  { game: '3a36dac7c7fc18ce', idx: 0, label: '東1局', grade: 'B-', rating: 0.7660781133654163 },
  { game: '3a36dac7c7fc18ce', idx: 1, label: '東2局', grade: 'S-', rating: 0.9483896126258187 },
  { game: '3a36dac7c7fc18ce', idx: 2, label: '東2局1本場', grade: 'S', rating: 0.766722210407826 },
  { game: '3a36dac7c7fc18ce', idx: 3, label: '東2局2本場', grade: 'A-', rating: 0.6573948436052126 },
  { game: '3a36dac7c7fc18ce', idx: 4, label: '東3局3本場', grade: 'S+', rating: 0.977456116873316 },
  { game: '3a36dac7c7fc18ce', idx: 5, label: '東3局4本場', grade: 'C+', rating: 0.8064564244564137 },
  { game: '3a36dac7c7fc18ce', idx: 6, label: '東4局', grade: 'A', rating: 0.8296200259959796 },
  { game: '3a36dac7c7fc18ce', idx: 7, label: '東4局1本場', grade: 'A+', rating: 0.9341333707856079 },
  { game: '3a36dac7c7fc18ce', idx: 8, label: '南1局2本場', grade: 'S', rating: 0.9380697781074089 },
  { game: '3a36dac7c7fc18ce', idx: 9, label: '南1局3本場', grade: 'A-', rating: 0.88808902063611 },
  { game: '3a36dac7c7fc18ce', idx: 10, label: '南2局', grade: 'S+', rating: 1 },
  { game: '3a36dac7c7fc18ce', idx: 11, label: '南2局1本場', grade: 'A+', rating: 0.8618027910229377 },
  { game: '3a36dac7c7fc18ce', idx: 12, label: '南3局', grade: 'A-', rating: 0.7998806248995253 },
  { game: '3a36dac7c7fc18ce', idx: 13, label: '南3局1本場', grade: 'S+', rating: 0.9815495391878187 },
  { game: '3a36dac7c7fc18ce', idx: 14, label: '南4局', grade: 'A', rating: 0.9009773933991574 },
];
