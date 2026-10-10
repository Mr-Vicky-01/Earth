/**
 * Splits text into per-character spans (`.ch`, with `--i` index) grouped by word (`.w`),
 * so words never break mid-way. Spaces stay as real spaces between words.
 */
export function Chars({ text, charClass = 'ch', offset = 0 }) {
  let i = offset
  const words = String(text).split(' ')
  return words.map((word, wi) => (
    <span key={wi}>
      <span className="w">
        {Array.from(word).map((c, ci) => (
          <span key={ci} className={charClass} style={{ '--i': i++ }}>
            {c}
          </span>
        ))}
      </span>
      {wi < words.length - 1 ? ' ' : null}
    </span>
  ))
}

export const countChars = (text) => String(text).replace(/ /g, '').length
