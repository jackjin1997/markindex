export type TokenCounter = (text: string) => number

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u

/** Approximate tokens: each CJK character is 1 token, everything else is chars / 4 rounded up. */
export const approxTokens: TokenCounter = (text) => {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}
