/**
 * Porter (1980) stemming for `Lexicon.stem: 'porter-en'`: "refunded", "refunding", "refunds" ->
 * "refund". A port of the `stemmer` npm package 2.0.1,
 * reproduced output for output on a golden vocabulary (test/fixtures/porter-golden.json). No
 * dependencies, no Node built-ins: edge-safe like the rest of the package root.
 *
 * Linear time: tokens longer than 40 characters, or containing anything but letters and apostrophes
 * (digits, underscores), are returned unchanged. No natural word is that long, and some of the
 * patterns below nest quantifiers, so a pathological token can't make matching slow.
 *
 * Adapted from https://github.com/words/stemmer:
 *
 *   (The MIT License)
 *   Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the 'Software'), to deal in the Software without restriction,
 *   including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 *   OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const STEP2: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};
const STEP3: Record<string, string> = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };

const consonant = '[^aeiou]';
const vowel = '[aeiouy]';
const consonants = `(${consonant}[^aeiouy]*)`;
const vowels = `(${vowel}[aeiou]*)`;
const gt0 = new RegExp(`^${consonants}?${vowels}${consonants}`);
const eq1 = new RegExp(`^${consonants}?${vowels}${consonants}${vowels}?$`);
const gt1 = new RegExp(`^${consonants}?(${vowels}${consonants}){2,}`);
const vowelInStem = new RegExp(`^${consonants}?${vowel}`);
const consonantLike = new RegExp(`^${consonants}${vowel}[^aeiouwxy]$`);

const sfxLl = /ll$/;
const sfxE = /^(.+?)e$/;
const sfxY = /^(.+?)y$/;
const sfxIon = /^(.+?(s|t))(ion)$/;
const sfxEdOrIng = /^(.+?)(ed|ing)$/;
const sfxAtOrBlOrIz = /(at|bl|iz)$/;
const sfxEED = /^(.+?)eed$/;
const sfxS = /^.+?[^s]s$/;
const sfxSsesOrIes = /^.+?(ss|i)es$/;
const sfxMultiConsonantLike = /([^aeiouylsz])\1$/;
const step2 = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const step3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const step4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const STEMMABLE = /^[\p{L}\p{M}']{1,40}$/u;

/** The Porter stem of one lower-case token (tokens that aren't plain words are returned unchanged). */
export function porterStem(value: string): string {
  if (!STEMMABLE.test(value)) return value;
  let result = value.toLowerCase();
  if (result.length < 3) return result;

  // An initial y never counts as a vowel.
  const initialY = result.codePointAt(0) === 121;
  if (initialY) result = `Y${result.slice(1)}`;

  // Step 1a.
  if (sfxSsesOrIes.test(result)) result = result.slice(0, -2);
  else if (sfxS.test(result)) result = result.slice(0, -1);

  // Step 1b.
  let match: RegExpExecArray | null;
  if ((match = sfxEED.exec(result))) {
    if (gt0.test(match[1])) result = result.slice(0, -1);
  } else if ((match = sfxEdOrIng.exec(result)) && vowelInStem.test(match[1])) {
    result = match[1];
    if (sfxAtOrBlOrIz.test(result)) result += 'e';
    else if (sfxMultiConsonantLike.test(result)) result = result.slice(0, -1);
    else if (consonantLike.test(result)) result += 'e';
  }

  // Step 1c.
  if ((match = sfxY.exec(result)) && vowelInStem.test(match[1])) result = `${match[1]}i`;

  // Steps 2 and 3.
  if ((match = step2.exec(result)) && gt0.test(match[1])) result = match[1] + STEP2[match[2]];
  if ((match = step3.exec(result)) && gt0.test(match[1])) result = match[1] + STEP3[match[2]];

  // Step 4.
  if ((match = step4.exec(result))) {
    if (gt1.test(match[1])) result = match[1];
  } else if ((match = sfxIon.exec(result)) && gt1.test(match[1])) {
    result = match[1];
  }

  // Step 5.
  if ((match = sfxE.exec(result)) && (gt1.test(match[1]) || (eq1.test(match[1]) && !consonantLike.test(match[1])))) result = match[1];
  if (sfxLl.test(result) && gt1.test(result)) result = result.slice(0, -1);

  return initialY ? `y${result.slice(1)}` : result;
}
