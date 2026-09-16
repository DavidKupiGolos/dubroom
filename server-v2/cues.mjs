const defaultOptions = Object.freeze({
  pauseThresholdSeconds: 0.6,
  maxDurationSeconds: 7,
  maxCharacters: 84,
  minimumDurationSeconds: 0.35,
});

function isWord(item) {
  return item && item.type === "word" && typeof item.text === "string"
    && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start;
}

function joinTokens(tokens) {
  return tokens.join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

function endsSentence(text) {
  return /[.!?…]["'»)]?$/.test(text.trim());
}

export function buildCues(words, inputOptions = {}) {
  const options = { ...defaultOptions, ...inputOptions };
  const source = Array.isArray(words) ? words.filter(isWord).sort((a, b) => a.start - b.start) : [];
  const cues = [];
  let current = [];
  let start = 0;
  let end = 0;

  function flush() {
    if (!current.length) return;
    const text = joinTokens(current.map((word) => word.text));
    if (text) {
      cues.push({
        id: randomCueId(cues.length),
        start,
        end: Math.max(end, start + options.minimumDurationSeconds),
        text,
      });
    }
    current = [];
  }

  for (const word of source) {
    if (!current.length) {
      current = [word];
      start = word.start;
      end = word.end;
      continue;
    }

    const previous = current[current.length - 1];
    const pause = Math.max(0, word.start - previous.end);
    const nextText = joinTokens([...current.map((item) => item.text), word.text]);
    const nextDuration = word.end - start;
    const sentenceBreak = endsSentence(previous.text) && pause >= Math.min(0.25, options.pauseThresholdSeconds);
    const hardBreak = pause >= options.pauseThresholdSeconds
      || nextDuration > options.maxDurationSeconds
      || nextText.length > options.maxCharacters;

    if (sentenceBreak || hardBreak) {
      flush();
      current = [word];
      start = word.start;
      end = word.end;
    } else {
      current.push(word);
      end = word.end;
    }
  }
  flush();
  return cues;
}

function randomCueId(index) {
  return `cue-${String(index + 1).padStart(4, "0")}`;
}
