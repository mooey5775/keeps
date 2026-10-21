// The NATO phonetic alphabet, so a room code can be read out loud ("MTUC" →
// "Mike Tango Uniform Charlie") without "B or D?" confusion.

const NATO: Record<string, string> = {
  A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf',
  H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November',
  O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform',
  V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

/** "MTUC" → ["Mike", "Tango", "Uniform", "Charlie"]. Non-letters pass through. */
export function natoWords(code: string): string[] {
  return [...code.toUpperCase()].map((c) => NATO[c] ?? c);
}

export function natoSpelling(code: string): string {
  return natoWords(code).join(' · ');
}
